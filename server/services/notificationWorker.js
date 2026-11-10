'use strict';

const config = require('../config/env');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const { NOTIFY } = require('../config/constants');
const { runAsTenant, runUnscoped } = require('../utils/tenantContext');
const mailer = require('./mailer');
const slaService = require('./slaService');
const webhookService = require('./webhookService');
const Heartbeat = require('../models/Heartbeat');
const { logger } = require('../utils/logger');

const backoff = (attempts) => NOTIFY.BACKOFF_MS[Math.min(attempts, NOTIFY.BACKOFF_MS.length) - 1];

// Takes the oldest due e-mail across all institutions. The claim is one atomic update (it stamps
// lockedAt and counts the attempt), so two workers can never take the same message. A claim older
// than LOCK_MS belongs to a crashed worker and may be taken again.
function claim(now) {
  return runUnscoped(() =>
    Notification.findOneAndUpdate(
      {
        channel: 'EMAIL', status: 'PENDING', template: { $ne: null }, notBefore: { $lte: now },
        $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - NOTIFY.LOCK_MS) } }],
      },
      { $set: { lockedAt: now }, $inc: { attempts: 1 } },
      { sort: { notBefore: 1 }, returnDocument: 'after' }
    )
  );
}

const finish = (n, set) => runUnscoped(() => Notification.updateOne({ _id: n._id, status: 'PENDING' }, { $set: { ...set, lockedAt: null } }));

// One message: look the person up now (so the address is current and an opt-out or deactivation
// since it was queued is respected), render, send. Returns what happened.
async function deliver(n, now) {
  const user = await runAsTenant(n.tenantId, () => User.findOne({ _id: n.userId }, 'name email isActive notifyEmail'));
  if (!user || !user.isActive || user.notifyEmail === false) {
    await finish(n, { status: 'CANCELLED', lastError: null });
    return 'cancelled';
  }
  const tenant = await Tenant.findById(n.tenantId, 'name slug');
  const link = n.requestId && tenant ? `${config.publicUrl}/t/${tenant.slug}/request.html?id=${n.requestId}` : undefined;
  try {
    await mailer.send({
      to: user.email, template: n.template, idempotencyKey: String(n._id),
      data: { ...(n.data || {}), name: user.name, institution: tenant ? tenant.name : undefined, link },
    });
  } catch (err) {
    const message = String((err && err.message) || 'delivery failed').slice(0, 200);
    if (n.attempts >= NOTIFY.MAX_ATTEMPTS) {
      await finish(n, { status: 'FAILED', lastError: message });
      return 'failed';
    }
    await finish(n, { notBefore: new Date(now.getTime() + backoff(n.attempts)), lastError: message });
    return 'retry';
  }
  await finish(n, { status: 'SENT', sentAt: new Date(), lastError: null });
  return 'sent';
}

/**
 * One pass: deliver due e-mails (up to `limit`), then look at SLA timers. Safe to run from several
 * processes at once. `now` can be given (tests move the clock this way).
 */
async function runOnce({ now = new Date(), limit = NOTIFY.BATCH } = {}) {
  const report = { sent: 0, retry: 0, failed: 0, cancelled: 0, reminders: 0, escalations: 0 };
  for (let i = 0; i < limit; i += 1) {
    const n = await claim(now);
    if (!n) break;
    report[await deliver(n, now)] += 1;
  }
  const sla = await slaService.scan({ now });
  report.reminders = sla.reminders;
  report.escalations = sla.escalations;
  report.webhooks = await webhookService.deliverDue({ now });
  // Proof of life for /readyz and the status page. Counts only.
  await Heartbeat.updateOne({ name: 'worker' }, { $set: { at: new Date(), lastResult: report } }, { upsert: true }).catch(() => {});
  return report;
}

// A simple loop. Errors are logged (message only) and never stop it.
function start({ intervalMs = NOTIFY.POLL_MS } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      logger.error('worker pass failed', { error: err.message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

module.exports = { runOnce, start, claim, backoff };
