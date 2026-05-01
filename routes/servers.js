/* routes/servers.js — actions on a Minecraft server */

import {
  listServers, getServer,
  startServer, stopServer, restartServer, getServerStatus,
  getServerMetrics, getServerUptimeStats,
  rconCommand,
  listFiles, readServerFile, writeServerFile,
  downloadServerFile, uploadServerFile,
  createFolder, renameServerEntry, deleteServerEntry,
  getServerLogs, streamServerLogs,
  getAutoStopMinutes, setAutoStopMinutes,
  getOnlinePlayerCount,
} from '../servers.js';
import {
  listWorldFolders, downloadWorldZip, uploadAndReplaceWorld,
  listGameLogs, readGameLog, downloadAllGameLogs,
} from '../world.js';
import { getEmptySince } from '../auto-stop.js';
import { audit } from '../audit.js';
import { requireAuth, requireRole } from '../roles.js';
import { fork } from 'node:child_process';
import path from 'node:path';

const MC_USERNAME = /^[a-zA-Z0-9_]{3,16}$/;
const ALLOWED_AUTO_STOP = [0, 5, 15, 30, 60, 120];

export const MAX_UPLOAD_BYTES = Infinity;

function visibleServers(user) {
  const all = listServers();
  if (user.is_super) return all;
  return all.filter(s => user.permissions[s.name]);
}

function requireServerStopped(req, reply) {
  const name = req.params.name;
  return getServerStatus(name)
    .then((status) => {
      if (status.running) {
        reply.code(409).send({
          error: 'server is running',
          detail: 'this operation requires the server to be stopped first',
        });
        return reply;
      }
    })
    .catch(() => {
      reply.code(500).send({ error: 'could not check server status' });
      return reply;
    });
}

export default async function (app) {

  app.get('/api/servers', { preHandler: requireAuth }, async (req) => {
    const servers = visibleServers(req.user);
    const out = [];
    for (const s of servers) {
      const status = await getServerStatus(s.name).catch(() => ({ running: false }));
      const role   = req.user.is_super ? 'operator' : req.user.permissions[s.name];
      out.push({ ...s, ...status, role });
    }
    return { servers: out };
  });

  app.get('/api/servers/:name/status', { preHandler: requireRole('starter') }, async (req) => {
    return getServerStatus(req.params.name);
  });

  app.get('/api/servers/:name/metrics', { preHandler: requireRole('starter') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });
    return { metrics: getServerMetrics(name) };
  });

  app.get('/api/servers/:name/uptime', { preHandler: requireRole('starter') }, async (req, reply) => {
    try {
      return await getServerUptimeStats(req.params.name);
    } catch (e) {
      return reply.code(404).send({ error: e.message });
    }
  });

  app.post('/api/servers/:name/start', { preHandler: requireRole('starter') }, async (req, reply) => {
    const r = await startServer(req.params.name);
    audit(req, 'server.start', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    const r = await stopServer(req.params.name);
    audit(req, 'server.stop', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/restart', { preHandler: requireRole('operator') }, async (req, reply) => {
    const r = await restartServer(req.params.name);
    audit(req, 'server.restart', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/whitelist/add', { preHandler: requireRole('operator') }, async (req, reply) => {
    const username = (req.body?.username || '').trim();
    if (!MC_USERNAME.test(username)) return reply.code(400).send({ error: 'invalid minecraft username' });
    const result = await rconCommand(req.params.name, `whitelist add ${username}`);
    audit(req, 'whitelist.add', req.params.name, { username, result });
    return { ok: true, result };
  });

  app.post('/api/servers/:name/whitelist/remove', { preHandler: requireRole('operator') }, async (req, reply) => {
    const username = (req.body?.username || '').trim();
    if (!MC_USERNAME.test(username)) return reply.code(400).send({ error: 'invalid minecraft username' });
    const result = await rconCommand(req.params.name, `whitelist remove ${username}`);
    audit(req, 'whitelist.remove', req.params.name, { username, result });
    return { ok: true, result };
  });

  app.get('/api/servers/:name/whitelist', { preHandler: requireRole('operator') }, async (req) => {
    const result = await rconCommand(req.params.name, 'whitelist list');
    return { result };
  });

  app.post('/api/servers/:name/console', { preHandler: requireRole('operator') }, async (req, reply) => {
    const command = (req.body?.command || '').trim();
    if (!command || command.length > 1000) return reply.code(400).send({ error: 'invalid command' });
    const result = await rconCommand(req.params.name, command);
    
    // Ignore background polling commands used by the frontend UI
    const isPolling = /^list$|^data get entity [a-zA-Z0-9_]+ (Pos|Health|foodLevel|Dimension)$/i.test(command);
    
    if (!isPolling) {
      audit(req, 'console.command', req.params.name, { command, result_preview: result.slice(0, 200) });
    }
    
    return { result };
  });

  app.get('/api/servers/:name/logs', { preHandler: requireRole('operator') }, async (req, reply) => {
    const lines = Math.min(parseInt(req.query.lines, 10) || 200, 2000);
    try {
      const text = await getServerLogs(req.params.name, lines);
      return { lines, text };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/logs/download', { preHandler: requireRole('operator') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });

    audit(req, 'logs.download', name);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${name}-${stamp}.log"`);

    const stream = streamServerLogs(name);
    return reply.send(stream);
  });

  /* ---- game logs ---- */

  /* list all archived + current game log files */
  app.get('/api/servers/:name/game-log/files', { preHandler: requireRole('operator') }, async (req, reply) => {
    try {
      const files = await listGameLogs(req.params.name);
      return { files };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /* read one log (decompresses .gz) */
  app.get('/api/servers/:name/game-log/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const file = req.query.name;
    if (!file) return reply.code(400).send({ error: 'name required' });
    try {
      const text = await readGameLog(req.params.name, file);
      return { name: file, content: text };
    } catch (e) {
      return reply.code(404).send({ error: e.message });
    }
  });

  /* download just the current latest.log as text (kept for backwards compat) */
  app.get('/api/servers/:name/game-log/download', { preHandler: requireRole('operator') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });

    try {
      const content = await readServerFile(name, 'logs/latest.log');
      audit(req, 'game-log.download', name);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${name}-game-${stamp}.log"`);
      return reply.send(content);
    } catch (e) {
      return reply.code(404).send({ error: e.message });
    }
  });

  /* download every log file in the logs/ folder as a zip */
  app.get('/api/servers/:name/game-log/download-all', { preHandler: requireRole('operator') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });

    try {
      audit(req, 'game-log.download-all', name);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${name}-all-logs-${stamp}.zip"`);
      const stream = downloadAllGameLogs(name);
      return reply.send(stream);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /* ---- auto-stop ---- */
  app.get('/api/servers/:name/auto-stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    if (!getServer(req.params.name)) return reply.code(404).send({ error: 'unknown server' });
    return { minutes: getAutoStopMinutes(req.params.name) };
  });

  app.put('/api/servers/:name/auto-stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    const minutes = parseInt(req.body?.minutes, 10);
    if (!ALLOWED_AUTO_STOP.includes(minutes)) {
      return reply.code(400).send({ error: 'minutes must be one of: ' + ALLOWED_AUTO_STOP.join(', ') });
    }
    try {
      setAutoStopMinutes(req.params.name, minutes);
      audit(req, 'auto-stop.set', req.params.name, { minutes });
      return { ok: true, minutes };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/auto-stop/status', { preHandler: requireRole('operator') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });

    const minutes = getAutoStopMinutes(name);
    const status  = await getServerStatus(name).catch(() => ({ running: false }));

    if (!status.running) {
      return { minutes, running: false, players: null, empty_since: null, stops_in_seconds: null };
    }

    const players = await getOnlinePlayerCount(name);
    const emptySince = getEmptySince(name);

    let stopsInSeconds = null;
    if (minutes > 0 && players === 0 && emptySince) {
      const elapsed = Date.now() - emptySince;
      const total   = minutes * 60 * 1000;
      stopsInSeconds = Math.max(0, Math.round((total - elapsed) / 1000));
    }

    return { minutes, running: true, players, empty_since: emptySince, stops_in_seconds: stopsInSeconds };
  });

  /* ---- server creation ---- */
  app.post('/api/servers/create', { preHandler: requireSuper }, async (req, reply) => {
    const { name, display, type, version, port, rconPort, ramMax, ramMin } = req.body;

    // Security check for the server name
    if (!/^[a-z0-9-]+$/.test(name)) {
      return reply.code(400).send({ error: 'Invalid name (lowercase, numbers, and hyphens only)' });
    }

    const scriptPath = path.join(process.cwd(), 'scripts', 'add-server.js');

    // Launch the script in the background
    const child = fork(scriptPath, [
      name, display, type, version, port, rconPort, ramMax, ramMin
    ], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref(); // Allow the dashboard to keep running independently

    audit(req, 'server.create_initiated', name, { display, type, version });
    return { ok: true, message: 'Server creation started in the background.' };
  });

  /* ---------- file management ---------- */

  app.get('/api/servers/:name/files', { preHandler: requireRole('operator') }, async (req, reply) => {
    const path = req.query.path || '.';
    try {
      const items = await listFiles(req.params.name, path);
      return { path, items };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const path = req.query.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    try {
      const content = await readServerFile(req.params.name, path);
      return { path, content };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/file/download', { preHandler: requireRole('operator') }, async (req, reply) => {
    const path = req.query.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    try {
      const { stream, size, name: filename } = await downloadServerFile(req.params.name, path);
      audit(req, 'file.download', req.params.name, { path, size });

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(size));
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return reply.send(stream);
    } catch (e) {
      return reply.code(404).send({ error: e.message });
    }
  });

  app.put('/api/servers/:name/file', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    const { path, content } = req.body || {};
    if (!path || typeof content !== 'string') return reply.code(400).send({ error: 'path and content required' });
    try {
      await writeServerFile(req.params.name, path, content);
      audit(req, 'file.write', req.params.name, { path, bytes: Buffer.byteLength(content) });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/servers/:name/upload', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'expected multipart upload' });

    const folder = req.query.path || '.';
    let written = null;
    let filename = null;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          filename = part.filename;
          const r = await uploadServerFile(req.params.name, folder, filename, part.file, MAX_UPLOAD_BYTES);
          written = r.bytes;
          break;
        }
      }

      if (written === null) return reply.code(400).send({ error: 'no file in upload' });

      audit(req, 'file.upload', req.params.name, { folder, filename, bytes: written });
      return { ok: true, filename, bytes: written };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/servers/:name/mkdir', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    const { path: parent, name: folderName } = req.body || {};
    if (typeof folderName !== 'string') return reply.code(400).send({ error: 'name required' });
    try {
      await createFolder(req.params.name, parent || '.', folderName);
      audit(req, 'folder.create', req.params.name, { parent, name: folderName });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/servers/:name/rename', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    const { from, to } = req.body || {};
    if (typeof from !== 'string' || typeof to !== 'string') return reply.code(400).send({ error: 'from and to required' });
    try {
      await renameServerEntry(req.params.name, from, to);
      audit(req, 'entry.rename', req.params.name, { from, to });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.delete('/api/servers/:name/entry', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    const path = req.query.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    try {
      await deleteServerEntry(req.params.name, path);
      audit(req, 'entry.delete', req.params.name, { path });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /* ---------- world zip download / upload ---------- */

  app.get('/api/servers/:name/world/folders', { preHandler: requireRole('operator') }, async (req, reply) => {
    try {
      const folders = await listWorldFolders(req.params.name);
      return { folders };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/world/download', { preHandler: requireRole('operator') }, async (req, reply) => {
    const folder = req.query.folder || 'world';
    if (!getServer(req.params.name)) return reply.code(404).send({ error: 'unknown server' });

    try {
      audit(req, 'world.download', req.params.name, { folder });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${req.params.name}-${folder}-${stamp}.zip"`);
      const stream = downloadWorldZip(req.params.name, folder);
      return reply.send(stream);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/servers/:name/world/upload', {
    preHandler: [requireRole('operator'), requireServerStopped],
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'expected multipart upload' });
    const folder = req.query.folder || 'world';

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const r = await uploadAndReplaceWorld(req.params.name, folder, part.file);
          audit(req, 'world.upload', req.params.name, { folder, entries: r.entries, bytes: r.bytes });
          return { ok: true, folder, entries: r.entries, bytes: r.bytes };
        }
      }
      return reply.code(400).send({ error: 'no file in upload' });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
