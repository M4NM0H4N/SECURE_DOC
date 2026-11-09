'use strict';

const AuditLog = require('../models/AuditLog');

const SECRET_KEY = /pass(word)?|token|secret|hash|cookie|authorization/i;

// Never let credentials or tokens reach the audit trail, even by mistake.
function sanitize(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SECRET_KEY.test(k)) out[k] = sanitize(v, depth + 1);
  }
  return out;
}

// Strict write: used for state changes, inside the same transaction when available.
async function record({ actorId, action, requestId = null, details = {} }, { session } = {}) {
  const doc = { actorId, action, requestId, details: sanitize(details), timestamp: new Date() };
  const [created] = await AuditLog.create([doc], session ? { session } : {});
  return created;
}

// Best effort: used for login/download events, which must not block the user.
async function recordSafe(event) {
  try {
    return await record(event);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') console.error('Audit write failed:', event.action, err.message);
    return null;
  }
}

async function listAuditLogs({ action, requestId, actorId, page = 1, limit = 50 }) {
  const filter = {};
  if (action) filter.action = action;
  if (requestId) filter.requestId = requestId;
  if (actorId) filter.actorId = actorId;
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ timestamp: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('actorId', 'name role email'),
    AuditLog.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

module.exports = { record, recordSafe, listAuditLogs, sanitize };
