'use strict';

const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');
const AuditChain = require('../models/AuditChain');
const { currentScope } = require('../utils/tenantContext');
const { runInTransaction } = require('../config/transactions');
const { contains, sortSpec, dateRange } = require('../utils/listQuery');

const SECRET_KEY = /pass(word)?|token|secret|hash|cookie|authorization/i;
const GENESIS = 'GENESIS';

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

// The database drops undefined values and empty objects when it stores details. The hash must be
// taken over exactly what will be stored, or every entry with an emptied detail would look altered.
function normalize(value) {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const n = normalize(v);
    if (n && typeof n === 'object' && !Array.isArray(n) && !(n instanceof Date) && Object.keys(n).length === 0) continue;
    out[k] = n;
  }
  return out;
}

// ---- the hash chain -------------------------------------------------------------------------
// Each entry stores the hash of the previous one and its own hash over a canonical form of
//   institution, sequence number, actor, action, request, details, timestamp and previous hash.
// Changing, inserting or removing any entry breaks every hash after it, and the chain head
// (AuditChain) remembers the last sequence number and hash, so cutting off the newest entries is
// caught too. This is TAMPER-EVIDENT, not tamper-proof: someone with full database access could
// rewrite the whole chain and its head. Keep a copy of the head hash somewhere else (it is shown on
// the audit screen and in the export) so that can be noticed.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function entryHash({ tenantId, seq, actorId, action, requestId, details, timestamp, prevHash }) {
  const payload = canonical({
    t: tenantId ? String(tenantId) : null, s: seq, a: String(actorId), c: action,
    r: requestId ? String(requestId) : null, d: details || {}, ts: new Date(timestamp).toISOString(), p: prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function append({ actorId, action, requestId = null, details = {} }, session) {
  const scope = currentScope('AuditLog');
  const tenantId = scope.unscoped ? null : scope.tenantId;
  const opt = session ? { session } : {};
  const clean = normalize(sanitize(details));
  const timestamp = new Date();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const q = AuditChain.findOne({ tenantId });
    const chain = await (session ? q.session(session) : q);
    const seq = chain ? chain.seq + 1 : 1;
    const prevHash = chain ? chain.lastHash : GENESIS;
    const hash = entryHash({ tenantId, seq, actorId, action, requestId, details: clean, timestamp, prevHash });
    // Compare-and-swap on the head: only the writer that saw the current head may move it.
    if (chain) {
      const moved = await AuditChain.updateOne({ tenantId, seq: chain.seq }, { $set: { seq, lastHash: hash } }, opt);
      if (moved.matchedCount === 0) continue; // another writer got there first: read the head again
    } else {
      try {
        await AuditChain.create([{ tenantId, seq, lastHash: hash }], opt);
      } catch (err) {
        if (err && err.code === 11000) continue; // someone created it first
        throw err;
      }
    }
    const [created] = await AuditLog.create([{ tenantId, actorId, action, requestId, details: clean, timestamp, seq, prevHash, hash }], opt);
    return created;
  }
  throw new Error('Could not append to the audit chain');
}

// Strict write: used for state changes, inside the same transaction when available. Without a
// session it opens its own, so the head and the entry always commit together.
async function record(event, { session } = {}) {
  if (session) return append(event, session);
  return runInTransaction((s) => append(event, s));
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

// Walks one institution's chain and recomputes everything. Counts only; never entry content.
async function verifyChain() {
  const head = await AuditChain.findOne({});
  let expectedSeq = 1;
  let prev = GENESIS;
  let checked = 0;
  let broken = null;
  const fail = (seq, reason) => {
    if (!broken) broken = { seq, reason };
  };
  const unchained = await AuditLog.countDocuments({ seq: null });
  // Read in batches by sequence number (each batch is a normal tenant-scoped query).
  let after = 0;
  for (;;) {
    const batch = await AuditLog.find({ seq: { $gt: after } }).sort({ seq: 1 }).limit(1000).lean();
    if (!batch.length) break;
    for (const e of batch) {
      checked += 1;
      if (e.seq !== expectedSeq) {
        fail(expectedSeq, e.seq > expectedSeq ? 'an entry is missing' : 'sequence is out of order or duplicated');
        expectedSeq = e.seq;
      }
      if (e.prevHash !== prev) fail(e.seq, 'link to the previous entry does not match');
      if (entryHash({ ...e, prevHash: e.prevHash }) !== e.hash) fail(e.seq, 'the entry was altered');
      prev = e.hash;
      expectedSeq += 1;
    }
    after = batch[batch.length - 1].seq;
  }
  const lastSeq = expectedSeq - 1;
  if (head) {
    if (head.seq !== lastSeq || head.lastHash !== prev) fail(lastSeq + 1, head.seq > lastSeq ? 'the newest entries are missing' : 'the chain head does not match the entries');
  } else if (checked > 0) {
    fail(1, 'the chain head is missing');
  }
  return { ok: !broken, checked, unchained, headSeq: head ? head.seq : 0, headHash: head ? head.lastHash : null, broken };
}

// One-off: gives pre-S7 entries (no hash) their place in the chain, oldest first. Native writes on
// purpose (the model refuses updates). Run it when nothing else is writing audit entries.
async function backfillChain() {
  const scope = currentScope('AuditLog');
  const tenantId = scope.unscoped ? null : scope.tenantId;
  let chain = await AuditChain.findOne({ tenantId });
  let seq = chain ? chain.seq : 0;
  let prev = chain ? chain.lastHash : GENESIS;
  const legacy = await AuditLog.find({ seq: null }).sort({ timestamp: 1, _id: 1 }).lean();
  for (const e of legacy) {
    seq += 1;
    const hash = entryHash({ tenantId, seq, actorId: e.actorId, action: e.action, requestId: e.requestId, details: e.details, timestamp: e.timestamp, prevHash: prev });
    await AuditLog.collection.updateOne({ _id: e._id }, { $set: { seq, prevHash: prev, hash } });
    prev = hash;
  }
  if (legacy.length) {
    if (chain) await AuditChain.collection.updateOne({ _id: chain._id }, { $set: { seq, lastHash: prev } });
    else chain = await AuditChain.collection.insertOne({ tenantId, seq, lastHash: prev, createdAt: new Date(), updatedAt: new Date() });
  }
  return legacy.length;
}

function auditFilter({ action, requestId, actorId, from, to, q }) {
  const filter = {};
  if (action) filter.action = action;
  if (requestId) filter.requestId = requestId;
  if (actorId) filter.actorId = actorId;
  Object.assign(filter, dateRange('timestamp', from, to));
  if (q) filter.action = filter.action || contains(q); // free text matches the action name
  return filter;
}

async function listAuditLogs({ action, requestId, actorId, from, to, q, sort, order, page = 1, limit = 50 }) {
  const filter = auditFilter({ action, requestId, actorId, from, to, q });
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort(sortSpec({ sort, order, defaultSort: 'timestamp' }))
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('actorId', 'name role email'),
    AuditLog.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

module.exports = { record, recordSafe, listAuditLogs, auditFilter, sanitize, verifyChain, backfillChain, entryHash, GENESIS };
