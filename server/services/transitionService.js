'use strict';

const Request = require('../models/Request');
const { TRANSITIONS, REQUEST_STATUSES } = require('../config/constants');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');
const AppError = require('../utils/AppError');

const AUDIT_BY_TARGET = Object.freeze({
  UNDER_REVIEW: 'REQUEST_REVIEWED',
  APPROVED: 'REQUEST_APPROVED',
  REJECTED: 'REQUEST_REJECTED',
  FULFILLED: 'REQUEST_FULFILLED',
});

// Finds the single allowed transition for (target status, actor role).
function findRule(to, role) {
  return TRANSITIONS.find((t) => t.to === to && t.role === role) || null;
}

/**
 * Moves a request to `to` only if ALL of these hold at the moment of the write:
 *   - the actor's role is allowed to make this transition
 *   - the request belongs to the actor's department
 *   - the request is currently in the required "from" status
 *
 * The status and department checks are part of the update filter, so check and
 * write are one atomic operation: two concurrent actors cannot both succeed,
 * even on a standalone MongoDB.
 *
 * The audit record(s) are written in the same transaction when a replica set is
 * available, so a failed audit write rolls the status change back.
 *
 * Options:
 *   reason      rejection reason (REJECTED only)
 *   extraSet    extra fields to set atomically (e.g. documentPath for FULFILLED)
 *   extraAudit  additional audit events [{ action, details }]
 */
async function transition(actor, requestId, to, { reason, extraSet = {}, extraAudit = [] } = {}) {
  const rule = findRule(to, actor.role);
  if (!rule || !actor.department) throw new AppError(403, 'Access denied');

  const set = { ...extraSet, status: to };
  if (to === REQUEST_STATUSES.UNDER_REVIEW) set.reviewedBy = actor._id;
  if (to === REQUEST_STATUSES.APPROVED || to === REQUEST_STATUSES.REJECTED) set.decidedBy = actor._id;
  if (to === REQUEST_STATUSES.REJECTED) set.rejectionReason = reason;

  const entry = { from: rule.from, to, by: actor._id, at: new Date() };
  if (to === REQUEST_STATUSES.REJECTED) entry.note = reason;

  return runInTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    const updated = await Request.findOneAndUpdate(
      { _id: requestId, department: actor.department, status: rule.from },
      { $set: set, $push: { statusHistory: entry } },
      { returnDocument: 'after', runValidators: true, ...sessionOpt }
    );

    if (!updated) {
      // Nothing matched: work out why, without leaking out-of-scope requests.
      const existing = await Request.findOne({ _id: requestId, department: actor.department }, 'status', sessionOpt);
      if (!existing) throw new AppError(404, 'Request not found');
      throw new AppError(409, `Invalid status transition: request is ${existing.status}, expected ${rule.from}`);
    }

    for (const ev of extraAudit) {
      await audit.record({ actorId: actor._id, action: ev.action, requestId: updated._id, details: ev.details }, { session });
    }
    await audit.record(
      {
        actorId: actor._id,
        action: AUDIT_BY_TARGET[to],
        requestId: updated._id,
        details: { previousStatus: rule.from, newStatus: to },
      },
      { session }
    );
    return updated;
  });
}

module.exports = { transition, findRule };
