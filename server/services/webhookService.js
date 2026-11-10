'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const config = require('../config/env');
const Webhook = require('../models/Webhook');
const { WEBHOOK_EVENTS } = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const AppError = require('../utils/AppError');
const { NOTIFY } = require('../config/constants');
const { runAsTenant, runUnscoped } = require('../utils/tenantContext');
const { isPrivateAddress, safeLookup } = require('../utils/netguard');
const audit = require('./auditService');

const MAX_ATTEMPTS = 8;
const AUTO_DISABLE_AFTER = 10; // consecutive deliveries that gave up
const MAX_WEBHOOKS = 10;
const BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const opt = (session) => (session ? { session } : {});

const available = () => Boolean(config.webhookKey);

// ---- secrets: AES-256-GCM under WEBHOOK_ENCRYPTION_KEY (the signing secret must be readable to sign)
const key = () => crypto.createHash('sha256').update(`docflow-webhook:${config.webhookKey}`).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  const [iv, tag, body] = String(blob).split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

// ---- URL rules
function assertUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_e) {
    throw new AppError(400, 'The webhook URL is not valid');
  }
  const insecureOk = config.webhookAllowPrivate;
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw new AppError(400, 'The webhook URL must use https');
  if (u.username || u.password) throw new AppError(400, 'The webhook URL must not contain a user name or password');
  if (u.hash) throw new AppError(400, 'The webhook URL must not contain a fragment');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!insecureOk && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    throw new AppError(400, 'That host name is not allowed');
  }
  const { isIP } = require('net');
  if (isIP(host) && !insecureOk && isPrivateAddress(host)) throw new AppError(400, 'Private and internal addresses are not allowed');
  return u.toString();
}

// ---- management
async function create(actor, { name, url, events }) {
  if (!available()) throw new AppError(503, 'Webhooks are not enabled on this server (WEBHOOK_ENCRYPTION_KEY is not set)');
  const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e) || e === 'ping');
  if (!events.length || bad.length) throw new AppError(400, `events must be from: ${WEBHOOK_EVENTS.filter((e) => e !== 'ping').join(', ')}`);
  if ((await Webhook.countDocuments({})) >= MAX_WEBHOOKS) throw new AppError(409, `An institution can have at most ${MAX_WEBHOOKS} webhooks`);
  const secret = newSecret();
  const hook = await Webhook.create({ name, url: assertUrl(url), events: [...new Set(events)], secretEnc: encrypt(secret), createdBy: actor._id });
  await audit.recordSafe({ actorId: actor._id, action: 'WEBHOOK_CREATED', details: { webhookId: String(hook._id), events: hook.events } });
  return { hook, secret };
}

const list = () => Webhook.find({}).sort({ createdAt: -1 }).limit(50);

async function update(actor, id, { name, url, events, active }) {
  const hook = await Webhook.findOne({ _id: id });
  if (!hook) throw new AppError(404, 'Webhook not found');
  if (name !== undefined) hook.name = name;
  if (url !== undefined) hook.url = assertUrl(url);
  if (events !== undefined) {
    if (!events.length || events.some((e) => !WEBHOOK_EVENTS.includes(e) || e === 'ping')) throw new AppError(400, 'Invalid events');
    hook.events = [...new Set(events)];
  }
  if (active !== undefined) {
    hook.active = active;
    if (active) {
      hook.consecutiveFailures = 0;
      hook.disabledReason = null;
    }
  }
  await hook.save();
  await audit.recordSafe({ actorId: actor._id, action: 'WEBHOOK_UPDATED', details: { webhookId: String(id) } });
  return hook;
}

async function remove(actor, id) {
  const res = await Webhook.deleteOne({ _id: id });
  if (res.deletedCount === 0) throw new AppError(404, 'Webhook not found');
  await WebhookDelivery.deleteMany({ webhookId: id });
  await audit.recordSafe({ actorId: actor._id, action: 'WEBHOOK_DELETED', details: { webhookId: String(id) } });
}

async function rotateSecret(actor, id) {
  if (!available()) throw new AppError(503, 'Webhooks are not enabled on this server');
  const secret = newSecret();
  const res = await Webhook.updateOne({ _id: id }, { $set: { secretEnc: encrypt(secret) } });
  if (res.matchedCount === 0) throw new AppError(404, 'Webhook not found');
  await audit.recordSafe({ actorId: actor._id, action: 'WEBHOOK_UPDATED', details: { webhookId: String(id), rotated: true } });
  return secret;
}

async function deliveries(id, { page = 1, limit = 50 } = {}) {
  const hook = await Webhook.findOne({ _id: id }, '_id');
  if (!hook) throw new AppError(404, 'Webhook not found');
  const filter = { webhookId: id };
  const [items, total] = await Promise.all([
    WebhookDelivery.find(filter, 'event status attempts lastStatus lastError sentAt createdAt notBefore').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    WebhookDelivery.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

// ---- events (written in the same transaction as the thing that happened)
async function emit(event, data, { session, key: eventKey } = {}) {
  if (!available()) return;
  const hooks = await Webhook.find({ active: true, events: event }, '_id').session(session || null);
  if (!hooks.length) return;
  const payload = { event, createdAt: new Date().toISOString(), data };
  for (const h of hooks) {
    await WebhookDelivery.updateOne(
      { dedupeKey: `${h._id}:${eventKey}` },
      { $setOnInsert: { webhookId: h._id, event, payload, notBefore: new Date() } },
      { upsert: true, ...opt(session) }
    );
  }
}

// A test event the Admin can trigger to check their endpoint.
async function ping(actor, id) {
  const hook = await Webhook.findOne({ _id: id });
  if (!hook) throw new AppError(404, 'Webhook not found');
  if (!hook.active) throw new AppError(409, 'This webhook is switched off');
  await WebhookDelivery.create({
    webhookId: hook._id, event: 'ping', dedupeKey: `${hook._id}:ping:${crypto.randomUUID()}`,
    payload: { event: 'ping', createdAt: new Date().toISOString(), data: { message: 'Test event from DocFlow' } },
  });
}

// ---- signing and delivery
// Signature header: "t=<unix seconds>,v1=<hex>" where v1 = HMAC-SHA256(secret, "<t>.<raw body>").
// Receivers should check the timestamp is recent (replay) and compare in constant time.
function sign(secret, timestamp, body) {
  return `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function post(urlString, headers, body) {
  const u = new URL(urlString);
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'POST', timeout: 10000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'DocFlow-Webhooks/1', ...headers },
        lookup: safeLookup({ allowPrivate: config.webhookAllowPrivate }),
      },
      (res) => {
        res.resume(); // the receiver's answer is never read or stored (redirects are NOT followed)
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(new Error(err.code === 'EBLOCKED' ? 'address not allowed' : err.message === 'timed out' ? 'timed out' : 'connection failed')));
    req.end(body);
  });
}

const backoff = (attempts) => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];

function claim(now) {
  return runUnscoped(() =>
    WebhookDelivery.findOneAndUpdate(
      { status: 'PENDING', notBefore: { $lte: now }, $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - NOTIFY.LOCK_MS) } }] },
      { $set: { lockedAt: now }, $inc: { attempts: 1 } },
      { sort: { notBefore: 1 }, returnDocument: 'after' }
    )
  );
}

async function deliverOne(d, now) {
  return runAsTenant(d.tenantId, async () => {
    const hook = await Webhook.findOne({ _id: d.webhookId }).select('+secretEnc');
    const done = (set) => WebhookDelivery.updateOne({ _id: d._id, status: 'PENDING' }, { $set: { ...set, lockedAt: null } });
    if (!hook || !hook.active) {
      await done({ status: 'FAILED', lastError: 'webhook removed or switched off' });
      return 'failed';
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(now.getTime() / 1000);
    let status = null;
    let error = null;
    try {
      status = await post(hook.url, { 'x-docflow-event': d.event, 'x-docflow-delivery': String(d._id), 'x-docflow-signature': sign(decrypt(hook.secretEnc), ts, body) }, body);
      if (status < 200 || status >= 300) error = `receiver answered ${status}`;
    } catch (err) {
      error = String(err.message).slice(0, 100);
    }
    if (!error) {
      await done({ status: 'SENT', sentAt: new Date(), lastStatus: status, lastError: null });
      if (hook.consecutiveFailures) await Webhook.updateOne({ _id: hook._id }, { $set: { consecutiveFailures: 0 } });
      return 'sent';
    }
    if (d.attempts >= MAX_ATTEMPTS) {
      await done({ status: 'FAILED', lastStatus: status, lastError: error });
      const updated = await Webhook.findOneAndUpdate({ _id: hook._id }, { $inc: { consecutiveFailures: 1 } }, { returnDocument: 'after' });
      if (updated && updated.consecutiveFailures >= AUTO_DISABLE_AFTER) {
        await Webhook.updateOne({ _id: hook._id }, { $set: { active: false, disabledReason: 'Switched off after repeated failures' } });
      }
      return 'failed';
    }
    await done({ notBefore: new Date(now.getTime() + backoff(d.attempts)), lastStatus: status, lastError: error });
    return 'retry';
  });
}

// One pass of the worker: deliver due webhook events.
async function deliverDue({ now = new Date(), limit = 25 } = {}) {
  const report = { sent: 0, retry: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const d = await claim(now);
    if (!d) break;
    report[await deliverOne(d, now)] += 1;
  }
  return report;
}

module.exports = { available, create, list, update, remove, rotateSecret, deliveries, emit, ping, sign, deliverDue, encrypt, decrypt, assertUrl, backoff, MAX_ATTEMPTS, AUTO_DISABLE_AFTER };
