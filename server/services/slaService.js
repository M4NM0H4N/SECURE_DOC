'use strict';

const Request = require('../models/Request');
const { REQUEST_STATUSES: S } = require('../config/constants');
const { runInTransaction } = require('../config/transactions');
const { runAsTenant, runUnscoped } = require('../utils/tenantContext');
const workflowService = require('./workflowService');
const notifications = require('./notificationService');

const WAITING = [S.PENDING, S.UNDER_REVIEW];

// Handles one request that has a timer due. Claiming the timer (setting it to null) and writing the
// notifications happen in ONE transaction, and the claim is a conditional update, so however many
// scanners run, each reminder and each escalation is produced exactly once.
async function processOne(id, now, report) {
  await runInTransaction(async (session) => {
    const o = session ? { session } : {};
    // Overdue: escalate (and drop the reminder, which would now be redundant).
    const overdue = await Request.findOneAndUpdate(
      { _id: id, status: { $in: WAITING }, slaDueAt: { $lte: now } },
      { $set: { slaDueAt: null, slaReminderAt: null } },
      { returnDocument: 'after', ...o }
    );
    if (overdue) {
      const def = await workflowService.getById(overdue.workflowDefinitionId, session);
      const step = def && def.steps[overdue.currentStepIndex];
      if (step) await notifications.onSla({ kind: 'escalation', request: overdue, step, session });
      report.escalations += 1;
      return;
    }
    // Nearing the deadline: remind.
    const due = await Request.findOneAndUpdate(
      { _id: id, status: { $in: WAITING }, slaReminderAt: { $lte: now }, slaDueAt: { $gt: now } },
      { $set: { slaReminderAt: null } },
      { returnDocument: 'after', ...o }
    );
    if (due) {
      const def = await workflowService.getById(due.workflowDefinitionId, session);
      const step = def && def.steps[due.currentStepIndex];
      if (step) await notifications.onSla({ kind: 'reminder', request: due, step, session });
      report.reminders += 1;
    }
  });
}

/**
 * Looks across every institution for requests whose reminder or deadline has passed and writes the
 * notifications. Each institution's work runs inside that institution's own tenant context.
 * Nothing is reassigned or approved automatically: a person still decides.
 * `now` can be given (tests move the clock this way).
 */
async function scan({ now = new Date(), limit = 200 } = {}) {
  const report = { reminders: 0, escalations: 0 };
  const candidates = await runUnscoped(() =>
    Request.find(
      { status: { $in: WAITING }, $or: [{ slaDueAt: { $lte: now } }, { slaReminderAt: { $lte: now } }] },
      '_id tenantId'
    ).limit(limit)
  );
  for (const c of candidates) await runAsTenant(c.tenantId, () => processOne(c._id, now, report));
  return report;
}

module.exports = { scan };
