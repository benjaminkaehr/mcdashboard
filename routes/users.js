/* routes/users.js — manage dashboard users (super-operator only) */

import { stmts } from '../db.js';
import { hashPassword } from '../auth.js';
import { listServers } from '../servers.js';
import { audit } from '../audit.js';
import { requireSuper } from '../roles.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function knownServer(name) {
  return listServers().some(s => s.name === name);
}

export default async function (app) {

  app.get('/api/users', { preHandler: requireSuper }, async () => {
    const users = stmts.listUsers.all();
    const out = users.map(u => {
      const perms = stmts.getPermissionsForUser.all(u.id);
      return {
        id:          u.id,
        username:    u.username,
        is_super:    !!u.is_super,
        created_at:  u.created_at,
        permissions: Object.fromEntries(perms.map(p => [p.server_name, p.role])),
      };
    });
    return { users: out };
  });

  app.post('/api/users', { preHandler: requireSuper }, async (req, reply) => {
    const { username, password, is_super = false } = req.body || {};
    if (!USERNAME_RE.test(username || ''))                return reply.code(400).send({ error: 'invalid username' });
    if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: 'password must be at least 6 chars' });
    if (stmts.getUserByUsername.get(username))            return reply.code(409).send({ error: 'username taken' });

    const hash = await hashPassword(password);
    const now  = Date.now();
    const info = stmts.insertUser.run(username, hash, is_super ? 1 : 0, now, now);
    audit(req, 'user.create', username, { is_super: !!is_super });
    return { ok: true, id: info.lastInsertRowid };
  });

  app.delete('/api/users/:id', { preHandler: requireSuper }, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id === req.user.id) return reply.code(400).send({ error: 'cannot delete this user' });
    const target = stmts.getUserById.get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    stmts.deleteUserSessions.run(id);
    stmts.deleteUser.run(id);
    audit(req, 'user.delete', target.username);
    return { ok: true };
  });

  app.put('/api/users/:id/super', { preHandler: requireSuper }, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const target = stmts.getUserById.get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });
    if (id === req.user.id) return reply.code(400).send({ error: 'cannot change your own super flag' });
    const flag = !!req.body?.is_super;
    stmts.setUserSuper.run(flag ? 1 : 0, Date.now(), id);
    audit(req, 'user.super', target.username, { is_super: flag });
    return { ok: true };
  });

  app.put('/api/users/:id/password', { preHandler: requireSuper }, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const target = stmts.getUserById.get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length < 6) return reply.code(400).send({ error: 'password must be at least 6 chars' });
    const hash = await hashPassword(password);
    stmts.updateUserPassword.run(hash, Date.now(), id);
    stmts.deleteUserSessions.run(id);
    audit(req, 'user.password.reset', target.username);
    return { ok: true };
  });

  app.put('/api/users/:id/permissions/:server', { preHandler: requireSuper }, async (req, reply) => {
    const id     = parseInt(req.params.id, 10);
    const server = req.params.server;
    const role   = req.body?.role;

    const target = stmts.getUserById.get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });
    if (!knownServer(server))               return reply.code(400).send({ error: 'unknown server' });
    if (!['starter', 'operator'].includes(role)) return reply.code(400).send({ error: 'role must be starter or operator' });

    stmts.setPermission.run(id, server, role);
    audit(req, 'user.permission.set', target.username, { server, role });
    return { ok: true };
  });

  app.delete('/api/users/:id/permissions/:server', { preHandler: requireSuper }, async (req, reply) => {
    const id     = parseInt(req.params.id, 10);
    const server = req.params.server;

    const target = stmts.getUserById.get(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    stmts.deletePermission.run(id, server);
    audit(req, 'user.permission.remove', target.username, { server });
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: requireSuper }, async (req) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Search parameters
    const username = req.query.username?.trim() || null;
    const ip = req.query.ip?.trim() || null;
    const action = req.query.action?.trim() || null;
    const target = req.query.target?.trim() || null;
    const fromDate = req.query.from ? new Date(req.query.from).getTime() : null;
    const toDate = req.query.to ? new Date(req.query.to).getTime() : null;

    // Prepare LIKE patterns (empty string means no filter)
    const usernamePattern = username ? `%${username}%` : '';
    const ipPattern = ip ? `%${ip}%` : '';
    const actionPattern = action ? `%${action}%` : '';
    const targetPattern = target ? `%${target}%` : '';
    const fromTimestamp = fromDate || 0;
    const toTimestamp = toDate || 0;

    // Get total count for pagination
    const countResult = stmts.countAudit.get(
      usernamePattern, username || '',
      ipPattern, ip || '',
      actionPattern, action || '',
      targetPattern, target || '',
      fromTimestamp, fromDate || 0,
      toTimestamp, toDate || 0
    );

    // Get filtered results with pagination
    const entries = stmts.searchAudit.all(
      usernamePattern, username || '',
      ipPattern, ip || '',
      actionPattern, action || '',
      targetPattern, target || '',
      fromTimestamp, fromDate || 0,
      toTimestamp, toDate || 0,
      limit
    );

    return {
      entries,
      total: countResult.total,
      limit,
      offset
    };
  });

  app.get('/api/audit/export', { preHandler: requireSuper }, async (req, reply) => {
    const username = req.query.username?.trim() || null;
    const ip = req.query.ip?.trim() || null;
    const action = req.query.action?.trim() || null;
    const target = req.query.target?.trim() || null;
    const fromDate = req.query.from ? new Date(req.query.from).getTime() : null;
    const toDate = req.query.to ? new Date(req.query.to).getTime() : null;

    // Prepare LIKE patterns (empty string means no filter)
    const usernamePattern = username ? `%${username}%` : '';
    const ipPattern = ip ? `%${ip}%` : '';
    const actionPattern = action ? `%${action}%` : '';
    const targetPattern = target ? `%${target}%` : '';
    const fromTimestamp = fromDate || 0;
    const toTimestamp = toDate || 0;

    // Get all matching entries (no limit for export)
    const entries = stmts.searchAudit.all(
      usernamePattern, username || '',
      ipPattern, ip || '',
      actionPattern, action || '',
      targetPattern, target || '',
      fromTimestamp, fromDate || 0,
      toTimestamp, toDate || 0,
      10000 // Reasonable limit for export
    );

    // Convert to CSV
    const csvHeader = 'timestamp,username,ip,action,target,details\n';
    const csvRows = entries.map(entry => {
      const timestamp = new Date(entry.ts).toISOString();
      const details = entry.details ? JSON.stringify(entry.details).replace(/"/g, '""') : '';
      return `"${timestamp}","${entry.username || ''}","${entry.ip || ''}","${entry.action}","${entry.target || ''}","${details}"`;
    }).join('\n');

    const csv = csvHeader + csvRows;

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.csv"`);
    return csv;
  });
}
