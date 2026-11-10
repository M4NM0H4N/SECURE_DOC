'use strict';

const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');
const { API_SCOPES } = require('../models/ApiKey');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const KEY_FORMAT = /^dfk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const MAX_ACTIVE_KEYS = 10;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function create(actor, { name, scopes, expiresInDays }) {
  const bad = scopes.filter((s) => !API_SCOPES.includes(s));
  if (!scopes.length || bad.length) throw new AppError(400, `scopes must be from: ${API_SCOPES.join(', ')}`);
  const active = await ApiKey.countDocuments({ revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  if (active >= MAX_ACTIVE_KEYS) throw new AppError(409, `An institution can have at most ${MAX_ACTIVE_KEYS} active API keys`);

  const prefix = crypto.randomBytes(6).toString('hex').slice(0, 8).replace(/[^a-z0-9]/g, 'a');
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = await ApiKey.create({
    name, prefix, secretHash: sha(secret), scopes: [...new Set(scopes)], createdBy: actor._id,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null,
  });
  await audit.recordSafe({ actorId: actor._id, action: 'API_KEY_CREATED', details: { keyId: String(key._id), scopes: key.scopes } });
  return { key, secret: `dfk_${prefix}_${secret}` }; // the only time the full key exists in readable form
}

const list = () => ApiKey.find({}).sort({ createdAt: -1 }).limit(100);

async function revoke(actor, id) {
  const res = await ApiKey.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (res.matchedCount === 0) throw new AppError(404, 'No active API key with that id');
  await audit.recordSafe({ actorId: actor._id, action: 'API_KEY_REVOKED', details: { keyId: String(id) } });
}

// Returns the key document for a valid, unexpired, unrevoked key of THIS institution, else null.
// Every failure looks the same to the caller. The comparison is constant-time.
async function authenticate(header) {
  const m = KEY_FORMAT.exec(typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '');
  if (!m) return null;
  const key = await ApiKey.findOne({ prefix: m[1] }).select('+secretHash');
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) return null;
  const given = Buffer.from(sha(m[2]), 'hex');
  const stored = Buffer.from(key.secretHash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
  // Remember use, at most once a minute.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60000) await ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } });
  return key;
}

module.exports = { create, list, revoke, authenticate, KEY_FORMAT, MAX_ACTIVE_KEYS };
