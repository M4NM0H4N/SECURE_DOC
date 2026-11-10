'use strict';

const userService = require('../services/userService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const auditService = require('../services/auditService');
const AuditLog = require('../models/AuditLog');
const { sendCsv, MAX_EXPORT_ROWS } = require('../utils/csv');

const userParams = (q) => ({ role: q.role, active: q.active, department: q.department, q: q.q, from: q.from, to: q.to, sort: q.sort, order: q.order, page: q.page, limit: q.limit });

const listUsers = asyncHandler(async (req, res) => ok(res, await userService.listUsers(userParams(req.query))));

const exportUsers = asyncHandler(async (req, res) => {
  const { header, rows, truncated } = await userService.exportUsers(userParams(req.query));
  await auditService.recordSafe({ actorId: req.user._id, action: 'DATA_EXPORTED', details: { kind: 'users', rows: rows.length } });
  if (truncated) res.setHeader('X-Export-Truncated', 'true');
  sendCsv(res, `users-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, isActive, department } = req.body;
  const user = await userService.updateUser(req.user, req.params.id, { name, isActive, department });
  return ok(res, { user }, 200, 'User updated');
});

const auditParams = (q) => ({ action: q.action, requestId: q.requestId, actorId: q.actorId, from: q.from, to: q.to, q: q.q, sort: q.sort, order: q.order, page: q.page, limit: q.limit });

const listAuditLogs = asyncHandler(async (req, res) => ok(res, await auditService.listAuditLogs(auditParams(req.query))));

// Walks the whole chain and recomputes every hash. Counts and the first problem only.
const verifyAuditChain = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return ok(res, await auditService.verifyChain());
});

const exportAuditLogs = asyncHandler(async (req, res) => {
  const filter = auditService.auditFilter(auditParams(req.query));
  const found = await AuditLog.find(filter).sort({ seq: 1, timestamp: 1, _id: 1 }).limit(MAX_EXPORT_ROWS + 1).populate('actorId', 'name role');
  const rows = found.slice(0, MAX_EXPORT_ROWS).map((e) => [
    e.seq === null ? '' : e.seq, e.timestamp, e.actorId && e.actorId.name ? e.actorId.name : '', e.actorId && e.actorId.role ? e.actorId.role : '',
    e.action, e.requestId ? String(e.requestId) : '', e.details, e.hash || '',
  ]);
  await auditService.recordSafe({ actorId: req.user._id, action: 'DATA_EXPORTED', details: { kind: 'audit', rows: rows.length } });
  if (found.length > MAX_EXPORT_ROWS) res.setHeader('X-Export-Truncated', 'true');
  sendCsv(res, `audit-${new Date().toISOString().slice(0, 10)}.csv`, ['seq', 'time', 'actor', 'role', 'action', 'request', 'details', 'hash'], rows);
});

module.exports = { listUsers, exportUsers, updateUser, listAuditLogs, verifyAuditChain, exportAuditLogs };

// Data portability: everything the institution holds, as one JSON file (no credentials).
const exportInstitutionData = asyncHandler(async (req, res) => {
  const bundle = await require('../services/dataLifecycleService').exportInstitution(req.user);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="institution-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.status(200).json(bundle);
});
module.exports.exportInstitutionData = exportInstitutionData;
