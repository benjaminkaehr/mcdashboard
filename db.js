/* =========================================================
   db.js — SQLite database setup and schema.
   ---------------------------------------------------------
   Tables:
     users           : dashboard accounts
     permissions     : per-server roles for each user
     sessions        : active login sessions
     audit_log       : append-only record of state-changing actions
     server_settings : per-server runtime settings (key/value)
   ========================================================= */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || './data/dashboard.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    is_super      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS permissions (
    user_id     INTEGER NOT NULL,
    server_name TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK (role IN ('starter', 'operator')),
    PRIMARY KEY (user_id, server_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    user_id   INTEGER,
    username  TEXT,
    ip        TEXT,
    action    TEXT    NOT NULL,
    target    TEXT,
    details   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

  CREATE TABLE IF NOT EXISTS server_settings (
    server_name TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (server_name, key)
  );
`);

export const stmts = {
  getUserByUsername:  db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:        db.prepare('SELECT * FROM users WHERE id = ?'),
  listUsers:          db.prepare('SELECT id, username, is_super, created_at FROM users ORDER BY username'),
  insertUser:         db.prepare(`
    INSERT INTO users (username, password_hash, is_super, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateUserPassword: db.prepare(`
    UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?
  `),
  setUserSuper:       db.prepare('UPDATE users SET is_super = ?, updated_at = ? WHERE id = ?'),
  deleteUser:         db.prepare('DELETE FROM users WHERE id = ?'),

  getPermissionsForUser: db.prepare('SELECT server_name, role FROM permissions WHERE user_id = ?'),
  getPermission:         db.prepare('SELECT role FROM permissions WHERE user_id = ? AND server_name = ?'),
  setPermission:         db.prepare(`
    INSERT INTO permissions (user_id, server_name, role) VALUES (?, ?, ?)
    ON CONFLICT(user_id, server_name) DO UPDATE SET role = excluded.role
  `),
  deletePermission:      db.prepare('DELETE FROM permissions WHERE user_id = ? AND server_name = ?'),

  insertSession:      db.prepare(`
    INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `),
  getSession:         db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
  deleteSession:      db.prepare('DELETE FROM sessions WHERE id = ?'),
  deleteExpired:      db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),

  insertAudit: db.prepare(`
    INSERT INTO audit_log (ts, user_id, username, ip, action, target, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  recentAudit: db.prepare(`
    SELECT ts, username, ip, action, target, details
    FROM audit_log ORDER BY ts DESC LIMIT ?
  `),
  searchAudit: db.prepare(`
    SELECT ts, username, ip, action, target, details
    FROM audit_log
    WHERE (username LIKE ? OR ? = '')
      AND (ip LIKE ? OR ? = '')
      AND (action LIKE ? OR ? = '')
      AND (target LIKE ? OR ? = '')
      AND (ts >= ? OR ? = 0)
      AND (ts <= ? OR ? = 0)
    ORDER BY ts DESC LIMIT ?
  `),
  countAudit: db.prepare(`
    SELECT COUNT(*) as total
    FROM audit_log
    WHERE (username LIKE ? OR ? = '')
      AND (ip LIKE ? OR ? = '')
      AND (action LIKE ? OR ? = '')
      AND (target LIKE ? OR ? = '')
      AND (ts >= ? OR ? = 0)
      AND (ts <= ? OR ? = 0)
  `),
  getServerAuditEvents: db.prepare(`
    SELECT ts, action
    FROM audit_log
    WHERE target = ? AND action IN ('server.start', 'server.stop')
    ORDER BY ts ASC
  `),

  getServerSetting:    db.prepare('SELECT value FROM server_settings WHERE server_name = ? AND key = ?'),
  setServerSetting:    db.prepare(`
    INSERT INTO server_settings (server_name, key, value) VALUES (?, ?, ?)
    ON CONFLICT(server_name, key) DO UPDATE SET value = excluded.value
  `),
  getAllServerSettings: db.prepare('SELECT server_name, key, value FROM server_settings'),
};

setInterval(() => {
  try { stmts.deleteExpired.run(Date.now()); } catch (e) { /* best effort */ }
}, 60 * 60 * 1000);
