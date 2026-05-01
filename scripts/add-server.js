#!/usr/bin/env node
/* =========================================================
   scripts/add-server.js
   Add a new Minecraft server to the dashboard
   Supports both CLI (Interactive) and GUI (Argument-based)
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
  // Check for arguments passed from the Web GUI
  // Expected order: name, display, type, version, port, rconPort, ramMax, ramMin
  const args = process.argv.slice(2);
  const isAutomated = args.length >= 8;

  let serversCfg;
  try {
    serversCfg = JSON.parse(await readFile(path.join(DASHBOARD, 'servers.json'), 'utf8'));
  } catch (e) {
    fail(`${DASHBOARD}/servers.json not found. Is the dashboard installed?`);
  }

  let name, displayName, typeChoice, mcVersion, port, rconPort, ramMax, ramMin;

  if (isAutomated) {
    // GUI MODE: Extract values from arguments
    [name, displayName, typeChoice, mcVersion, port, rconPort, ramMax, ramMin] = args;
    port = parseInt(port, 10);
    rconPort = parseInt(rconPort, 10);
    
    if (serversCfg.servers.some(s => s.name === name)) {
      fail(`A server named '${name}' already exists.`);
    }
    info(`Automated setup initiated for: ${name}`);
  } else {
    // CLI MODE: Interactive Questions
    console.clear();
    console.log('\x1b[34m================================================\x1b[0m');
    console.log('\x1b[34m  add a minecraft server (Node.js version)      \x1b[0m');
    console.log('\x1b[34m================================================\x1b[0m\n');

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

    displayName = await ask('display name (shown in UI)', name);

    console.log('\nserver type:');
    console.log('  1) vanilla     official Mojang server');
    console.log('  2) fabric      Fabric mod loader');
    console.log('  3) paper       Paper (performance fork of Spigot)');
    typeChoice = await ask('choice (1/2/3)', '1');
    mcVersion = await ask('minecraft version', '1.21.1');

    const usedPorts = new Set();
    for (const s of serversCfg.servers) {
      if (s.port) usedPorts.add(s.port);
      if (s.rcon && s.rcon.port) usedPorts.add(s.rcon.port);
    }

    let defaultPort = 25565;
    while (usedPorts.has(defaultPort)) defaultPort++;
    let defaultRconPort = 25575;
    while (usedPorts.has(defaultRconPort) || defaultRconPort === defaultPort) defaultRconPort++;

    while (true) {
      port = parseInt(await ask('minecraft port', String(defaultPort)), 10);
      if (usedPorts.has(port)) warn(`Port ${port} is already in use!`);
      else { usedPorts.add(port); break; }
    }

    while (true) {
      rconPort = parseInt(await ask('rcon port', String(defaultRconPort)), 10);
      if (usedPorts.has(rconPort)) warn(`Port ${rconPort} is already in use!`);
      else break;
    }

    ramMax = await ask('max RAM (e.g. 4G, 8G)', '4G');
    ramMin = await ask('min RAM', '2G');
  }

  if (rl) rl.close();

  // --- Start Installation Logic ---
  const rconPw = crypto.randomBytes(12).toString('hex');
  const folder = path.join(MCSERV_ROOT, name);
  
  info(`creating ${folder}...`);
  await mkdir(folder, { recursive: true });

  info('downloading server jar...');
  let launchJar = 'server.jar';

  try {
    if (typeChoice === '1') {
      const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const manifest = await manifestRes.json();
      const versionMeta = manifest.versions.find(v => v.id === mcVersion);
      if (!versionMeta) fail(`Minecraft version '${mcVersion}' not found.`);
      const pkgRes = await fetch(versionMeta.url);
      const pkg = await pkgRes.json();
      await download(pkg.downloads.server.url, path.join(folder, 'server.jar'));
    } else if (typeChoice === '2') {
      const loaderRes = await fetch('https://meta.fabricmc.net/v2/versions/loader');
      const loaders = await loaderRes.json();
      const loaderVer = loaders[0].version;
      const installerRes = await fetch('https://meta.fabricmc.net/v2/versions/installer');
      const installers = await installerRes.json();
      const installerVer = installers[0].version;
      const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/${installerVer}/server/jar`;
      launchJar = 'fabric-server-launch.jar';
      await download(url, path.join(folder, launchJar));
    } else if (typeChoice === '3') {
      const buildsRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds`);
      if (!buildsRes.ok) fail(`Version '${mcVersion}' not supported by paper.`);
      const buildsData = await buildsRes.json();
      const latestBuild = buildsData.builds[buildsData.builds.length - 1];
      const url = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild.build}/downloads/${latestBuild.downloads.application.name}`;
      await download(url, path.join(folder, 'server.jar'));
    }
  } catch (err) {
    fail(`Download failed: ${err.message}`);
  }

  await writeFile(path.join(folder, 'eula.txt'), 'eula=true\n');

  info('running first-run to generate properties...');
  await new Promise((resolve) => {
    const mcProcess = spawn('java', ['-Xmx' + ramMax, '-jar', launchJar, 'nogui'], { cwd: folder });
    const checkInterval = setInterval(() => {
      if (existsSync(path.join(folder, 'server.properties'))) {
        clearInterval(checkInterval);
        mcProcess.kill('SIGKILL');
        resolve();
      }
    }, 2000);
    setTimeout(() => { clearInterval(checkInterval); mcProcess.kill('SIGKILL'); resolve(); }, 60000);
  });

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

  const systemdDir = path.join(process.env.HOME, '.config/systemd/user');
  await mkdir(systemdDir, { recursive: true });
  const unitFile = `mc-${name}.service`;
  const unitContent = `[Unit]\nDescription=Minecraft: ${displayName}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${folder}\nExecStart=/usr/bin/java -Xms${ramMin} -Xmx${ramMax} -jar ${launchJar} nogui\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(path.join(systemdDir, unitFile), unitContent);
  
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable mc-${name}`);

  const envName = `RCON_PASSWORD_${name.toUpperCase().replace(/-/g, '_')}`;
  let envData = await readFile(path.join(DASHBOARD, '.env'), 'utf8');
  envData += `\n${envName}=${rconPw}\n`;
  await writeFile(path.join(DASHBOARD, '.env'), envData);

  serversCfg.servers.push({
    name,
    display_name: displayName,
    folder,
    port,
    systemd_unit: unitFile,
    rcon: { host: '127.0.0.1', port: rconPort, password_env: envName }
  });
  await writeFile(path.join(DASHBOARD, 'servers.json'), JSON.stringify(serversCfg, null, 2));

  execSync('systemctl --user restart dashboard');
  ok(`Setup complete for ${displayName}!`);
}

run().catch(err => fail(err.message));