/* =========================================================
   auto-stop.js — periodically stops idle Minecraft servers.
   ---------------------------------------------------------
   Runs every minute. For each server with a configured
   auto_stop_minutes > 0:
     1. Skip if not running
     2. Get online player count via RCON
     3. If 0 → mark "empty since" timestamp (or keep existing)
        If >0 → clear the timestamp
        If RCON failed → leave the timestamp alone (don't kill
        on transient errors)
     4. If empty for >= configured duration → stop the server

   In-memory state only. On dashboard restart the empty-since
   timer resets, which just delays auto-stop by up to one full
   duration. That's intentional — fail-safe rather than
   stopping immediately on boot.
   ========================================================= */

import {
  listServers, getServerStatus, getOnlinePlayerCount,
  getAutoStopMinutes, stopServer,
} from './servers.js';

const POLL_INTERVAL_MS = 60 * 1000;

/* server_name -> timestamp (ms) when it was first seen empty */
const emptySince = new Map();

export function getEmptySince(name) {
  return emptySince.get(name) || null;
}

async function tick(log) {
  for (const s of listServers()) {
    const minutes = getAutoStopMinutes(s.name);
    if (minutes <= 0) {
      emptySince.delete(s.name);
      continue;
    }

    const status = await getServerStatus(s.name).catch(() => ({ running: false }));
    if (!status.running) {
      emptySince.delete(s.name);
      continue;
    }

    const count = await getOnlinePlayerCount(s.name);

    if (count === null) {
      /* rcon failed — don't change anything */
      continue;
    }

    if (count > 0) {
      emptySince.delete(s.name);
      continue;
    }

    /* count === 0 */
    const now = Date.now();
    if (!emptySince.has(s.name)) {
      emptySince.set(s.name, now);
      log?.info({ server: s.name }, 'auto-stop: server now empty, starting timer');
      continue;
    }

    const idleMs = now - emptySince.get(s.name);
    if (idleMs >= minutes * 60 * 1000) {
      log?.info({ server: s.name, idle_minutes: Math.round(idleMs / 60000) },
                'auto-stop: stopping idle server');
      try {
        await stopServer(s.name);
      } catch (e) {
        log?.error({ server: s.name, err: e.message }, 'auto-stop: failed to stop server');
      }
      emptySince.delete(s.name);
    }
  }
}

export function startAutoStop(log) {
  log?.info('auto-stop loop starting (interval: 60s)');
  /* fire and forget every minute */
  setInterval(() => {
    tick(log).catch(e => log?.error({ err: e.message }, 'auto-stop tick failed'));
  }, POLL_INTERVAL_MS);
}
