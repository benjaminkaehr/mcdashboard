#!/usr/bin/env node
/* =========================================================
   scripts/addserver.js
   Add a new Minecraft server to the dashboard (Node.js CLI)
   ========================================================= */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const DASHBOARD = '/srv/dashboard';
const MCSERV_ROOT = '/srv/mcserv';

// Ensure script is not run as root
if (process.getuid() === 0) {
  console.error('\x1b[31m%s\x1b[0m', 'Do not run as root. Run as the user that owns /srv/dashboard.');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function ask(question, defaultVal = '') {
  const promptText = `\x1b[33m?\x1b[0m ${question} ${defaultVal ? `[${defaultVal}] ` : ''}`;
  const answer = await rl.question(promptText);
  return answer.trim() || defaultVal;
}

function info(msg) { console.log(`\x1b[34m==>\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m \x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m!\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\x1b[31m \x1b[0m ${msg}`); process.exit(1); }

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);
}

async function run() {
  console.clear();
  console.log('\x1b[34m================================================\x1b[0m');
  console.log('\x1b[34m  add a minecraft server (Node.js version)      \x1b[0m');
  console.log('\x1b[34m================================================\x1b[0m\n');

  // Load existing servers to check names and ports
  let serversCfg;
  try {
    serversCfg = JSON.parse(await readFile(path.join(DASHBOARD, 'servers.json'), 'utf8'));
  } catch (e) {
    fail(`${DASHBOARD}/servers.json not found. Is the dashboard installed?`);
  }

  // --- Ask Questions ---
  let name;
  while (true) {
    name = await ask('server name (lowercase, a-z 0-9 -, e.g. creative01)');
    if (/^[a-z0-9-]+$/.test(name)) {
      if (serversCfg.servers.some(s => s.name === name)) {
        warn(`A server named '${name}' already exists. Pick another.`);
      } else {
        break;
      }
    } else {
      warn('Invalid name. Lowercase letters, digits, hyphens only.');
    }
  }

  const displayName = await ask('display name (shown in UI)', name);

  console.log('\nserver type:');
  console.log('  1) vanilla     official Mojang server');
  console.log('  2) fabric      Fabric mod loader');
  console.log('  3) paper       Paper (performance fork of Spigot)');
  const typeChoice = await ask('choice (1/2/3)', '1');
  const mcVersion = await ask('minecraft version', '1.21.1');

  // --- Port Conflict Resolution ---
  // 1. Gather all currently used ports into a Set
  const usedPorts = new Set();
  for (const s of serversCfg.servers) {
    if (s.port) usedPorts.add(s.port);
    if (s.rcon && s.rcon.port) usedPorts.add(s.rcon.port);
  }

  // 2. Find the next available default ports
  let defaultPort = 25565;
  while (usedPorts.has(defaultPort)) defaultPort++;
  
  let defaultRconPort = 25575;
  // Ensure the default RCON port doesn't clash with used ports OR the new defaultPort
  while (usedPorts.has(defaultRconPort) || defaultRconPort === defaultPort) defaultRconPort++;

  // 3. Ask for ports and validate them against the Set
  let port;
  while (true) {
    port = parseInt(await ask('minecraft port', String(defaultPort)), 10);
    if (usedPorts.has(port)) {
      warn(`Port ${port} is already in use! Please choose another.`);
    } else {
      usedPorts.add(port); // Temporarily reserve it so RCON doesn't accidentally use it
      break;
    }
  }

  let rconPort;
  while (true) {
    rconPort = parseInt(await ask('rcon port', String(defaultRconPort)), 10);
    if (usedPorts.has(rconPort)) {
      warn(`Port ${rconPort} is already in use! Please choose another.`);
    } else {
      usedPorts.add(rconPort);
      break;
    }
  }

  const ramMax = await ask('max RAM (e.g. 4G, 8G)', '4G');
  const ramMin = await ask('min RAM', '2G');

  rl.close();

  // --- Generate RCON Password ---
  const rconPw = crypto.randomBytes(12).toString('hex');
  ok('generated rcon password');
  console.log('\n\x1b[32mgot it. starting setup...\x1b[0m\n');

  // --- Create Folder ---
  const folder = path.join(MCSERV_ROOT, name);
  info(`creating ${folder}...`);
  await mkdir(folder, { recursive: true });

  // --- Download Jar ---
  info('downloading server jar...');
  let launchJar = 'server.jar';

  try {
    if (typeChoice === '1') {
      // Vanilla
      const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const manifest = await manifestRes.json();
      const versionMeta = manifest.versions.find(v => v.id === mcVersion);
      if (!versionMeta) fail(`Minecraft version '${mcVersion}' not found.`);
      
      const pkgRes = await fetch(versionMeta.url);
      const pkg = await pkgRes.json();
      await download(pkg.downloads.server.url, path.join(folder, 'server.jar'));
      ok(`vanilla ${mcVersion} downloaded`);

    } else if (typeChoice === '2') {
      // Fabric
      const loaderRes = await fetch('https://meta.fabricmc.net/v2/versions/loader');
      const loaders = await loaderRes.json();
      const loaderVer = loaders[0].version;

      const installerRes = await fetch('https://meta.fabricmc.net/v2/versions/installer');
      const installers = await installerRes.json();
      const installerVer = installers[0].version;

      const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/${installerVer}/server/jar`;
      launchJar = 'fabric-server-launch.jar';
      await download(url, path.join(folder, launchJar));
      ok(`fabric ${mcVersion} downloaded`);

    } else if (typeChoice === '3') {
      // Paper
      const buildsRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds`);
      if (!buildsRes.ok) fail(`Minecraft version '${mcVersion}' not supported by paper.`);
      const buildsData = await buildsRes.json();
      const latestBuild = buildsData.builds[buildsData.builds.length - 1];
      
      const url = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild.build}/downloads/${latestBuild.downloads.application.name}`;
      await download(url, path.join(folder, 'server.jar'));
      ok(`paper ${mcVersion} build ${latestBuild.build} downloaded`);
    } else {
      fail('Invalid server type.');
    }
  } catch (err) {
    fail(`Download failed: ${err.message}`);
  }

  // --- Accept EULA ---
  await writeFile(path.join(folder, 'eula.txt'), 'eula=true\n');
  ok('EULA accepted');

  // --- First Run ---
  info('first-running the server to generate config files...');
  await new Promise((resolve, reject) => {
    const mcProcess = spawn('java', ['-Xmx' + ramMax, '-jar', launchJar, 'nogui'], { cwd: folder });
    
    let isDone = false;
    const checkInterval = setInterval(() => {
      if (existsSync(path.join(folder, 'server.properties'))) {
        clearInterval(checkInterval);
        isDone = true;
        mcProcess.kill('SIGKILL');
        ok('server.properties generated');
        resolve();
      }
    }, 2000);

    setTimeout(() => {
      if (!isDone) {
        clearInterval(checkInterval);
        mcProcess.kill('SIGKILL');
        fail('First-run timed out. server.properties was not generated.');
      }
    }, 120000); // 2 minute timeout
  });

  // --- Patch server.properties ---
  info('configuring server.properties...');
  let props = await readFile(path.join(folder, 'server.properties'), 'utf8');
  
  const setProp = (k, v) => {
    const regex = new RegExp(`^${k}=.*`, 'm');
    if (regex.test(props)) props = props.replace(regex, `${k}=${v}`);
    else props += `\n${k}=${v}`;
  };

  setProp('enable-rcon', 'true');
  setProp('rcon.port', rconPort);
  setProp('rcon.password', rconPw);
  setProp('white-list', 'true');
  setProp('server-port', port);
  setProp('query.port', port);

  await writeFile(path.join(folder, 'server.properties'), props);
  ok('server.properties configured');

  // --- Create Systemd Unit ---
  info('creating systemd unit...');
  const systemdDir = path.join(process.env.HOME, '.config/systemd/user');
  await mkdir(systemdDir, { recursive: true });
  
  const unitFile = `mc-${name}.service`;
  const unitContent = `[Unit]
Description=Minecraft server: ${displayName}
After=network.target

[Service]
Type=simple
WorkingDirectory=${folder}
ExecStart=/usr/bin/java -Xms${ramMin} -Xmx${ramMax} -jar ${launchJar} nogui
Restart=on-failure
RestartSec=10
SuccessExitStatus=0 143

[Install]
WantedBy=default.target
`;
  await writeFile(path.join(systemdDir, unitFile), unitContent);
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable mc-${name}`);
  ok(`systemd unit ${unitFile} created and enabled`);

  // --- Update .env ---
  const envName = `RCON_PASSWORD_${name.toUpperCase().replace(/-/g, '_')}`;
  info(`adding ${envName} to .env...`);
  let envData = await readFile(path.join(DASHBOARD, '.env'), 'utf8');
  const envRegex = new RegExp(`^${envName}=.*`, 'm');
  if (envRegex.test(envData)) {
    envData = envData.replace(envRegex, `${envName}=${rconPw}`);
  } else {
    envData += `\n${envName}=${rconPw}\n`;
  }
  await writeFile(path.join(DASHBOARD, '.env'), envData);
  ok(`${envName} written to .env`);

  // --- Update servers.json ---
  info('registering in servers.json...');
  serversCfg.servers.push({
    name,
    display_name: displayName,
    folder,
    port: port,
    systemd_unit: unitFile,
    rcon: {
      host: '127.0.0.1',
      port: rconPort,
      password_env: envName
    }
  });
  await writeFile(path.join(DASHBOARD, 'servers.json'), JSON.stringify(serversCfg, null, 2));
  ok('servers.json updated');

  // --- Restart Dashboard ---
  info('restarting dashboard...');
  execSync('systemctl --user restart dashboard');
  ok('dashboard back up');

  console.log('\n\x1b[32m================================================\x1b[0m');
  console.log(`\x1b[32m  '${name}' is ready                              \x1b[0m`);
  console.log('\x1b[32m================================================\x1b[0m\n');
  console.log(`  folder:      ${folder}`);
  console.log(`  port:        ${port}`);
  console.log(`  rcon port:   ${rconPort}`);
  console.log(`  systemd:     ${unitFile}\n`);
  console.log(`next: log in to your dashboard and click 'start' on '${displayName}'.\n`);
}

run().catch(err => fail(err.message));