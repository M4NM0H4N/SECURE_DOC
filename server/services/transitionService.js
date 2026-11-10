'use strict';

const Request = require('../models/Request');
const { REQUEST_STATUSES: S } = require('../config/constants');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');
const workflowService = require('./workflowService');
const { buildRules, candidates, ruleForState } = require('./workflowEngine');
const AppError = require('../utils/AppError');

const AUDIT_BY_TARGET = Object.freeze({
  [S.UNDER_REVIEW]: 'REQUEST_REVIEWED',
  [S.APPROVED]: 'REQUEST_APPROVED',
  [S.REJECTED]: 'REQUEST_REJECTED',
  [S.NEEDS_INFO]: 'REQUEST_INFO_REQUESTED',
  [S.FULFILLED]: 'REQUEST_FULFILLED',
});

/**
 * Moves a request to `to` only if ALL of these hold at the moment of the write:
 *   - the actor's role owns the step the request is currently waiting on
 *   - for department-scoped steps, the request belongs to the actor's department
 *   - the request is in the exact status and step the rule requires
 *
 * Rules come from the workflow version the request was pinned to when it was submitted,
 * so editing an institution's chain never reroutes work in progress.
 *
 * The status, step and department checks are part of the update filter, so check and
 * write are one atomic operation: two concurrent actors cannot both succeed, even on a
 * standalone MongoDB. (Every query below is also scoped to the actor's institution by the
 * tenant plugin.) The audit record(s) are written in the same transaction when a replica
 * set is available, so a failed audit write rolls the status change back.
 *
 * Errors: 403 role can never do this, 404 not found or out of scope, 409 wrong state.
 *
 * Options:
 *   reason      rejection reason (REJECTED) or the question for the student (NEEDS_INFO)
 *   extraSet    extra fields to set atomically
 *   extraAudit  additional audit events [{ action, details }]
 *   afterUpdate async (updatedRequest, session) => void, run INSIDE the same transaction after the
 *               status change (S4: creates the Document record, so file record and status commit together)
 */
async function transition(actor, requestId, to, { reason, extraSet = {}, extraAudit = [], afterUpdate } = {}) {
  const pre = await Request.findOne({ _id: requestId }, 'status currentStepIndex department workflowDefinitionId');

  // Role gate. Without a request to read, fall back to the institution's current chain
  // so a role that can never do this still gets 403 (not a misleading 404).
  const definition = pre ? await workflowService.getById(pre.workflowDefinitionId) : await workflowService.getCurrent();
  const rules = definition ? buildRules(definition) : [];
  const roleRules = candidates(rules, to, actor.role);
  if (!roleRules.length) throw new AppError(403, 'Access denied');
  if (!pre) throw new AppError(404, 'Request not found');

  // Scope: a department-scoped step is invisible to staff of other departments (404).
  if (roleRules.some((r) => r.departmentScoped) && !actor.department) throw new AppError(403, 'Access denied');
  const inScope = roleRules.filter((r) => !r.departmentScoped || pre.department === actor.department);
  if (!inScope.length) throw new AppError(404, 'Request not found');

  const rule = ruleForState(inScope, pre);
  if (!rule) {
    throw new AppError(409, `Invalid status transition: request is ${pre.status}, expected ${inScope[0].from}`);
  }

  const last = definition.steps.length - 1;
  const set = { ...extraSet, status: to };
  if (rule.kind === 'advance') {
    if (to === S.UNDER_REVIEW) set.currentStepIndex = rule.stepIndex + 1;
    if (rule.stepIndex === 0) set.reviewedBy = actor._id;
    if (to === S.APPROVED) set.decidedBy = actor._id;
  }
  if (to === S.REJECTED) {
    set.decidedBy = actor._id;
    set.rejectionReason = reason;
  }

  const entry = { from: rule.from, to, by: actor._id, at: new Date(), step: rule.stepLabel };
  if (to === S.REJECTED || to === S.NEEDS_INFO) entry.note = reason;

  const filter = { _id: requestId, status: rule.from, currentStepIndex: rule.stepIndex };
  if (rule.departmentScoped) filter.department = actor.department;

  return runInTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    const updated = await Request.findOneAndUpdate(
      filter,
      { $set: set, $push: { statusHistory: entry } },
      { returnDocument: 'after', runValidators: true, ...sessionOpt }
    );

    if (!updated) {
      // Lost a race (or the request moved on): work out why, without leaking out-of-scope requests.
      const scope = rule.departmentScoped ? { department: actor.department } : {};
      const existing = await Request.findOne({ _id: requestId, ...scope }, 'status', sessionOpt);
      if (!existing) throw new AppError(404, 'Request not found');
      throw new AppError(409, `Invalid status transition: request is ${existing.status}, expected ${rule.from}`);
    }

    if (afterUpdate) await afterUpdate(updated, session);

    for (const ev of extraAudit) {
      await audit.record({ actorId: actor._id, action: ev.action, requestId: updated._id, details: ev.details }, { session });
    }
    await audit.record(
      {
        actorId: actor._id,
        action: AUDIT_BY_TARGET[to],
        requestId: updated._id,
        details: { previousStatus: rule.from, newStatus: to, step: rule.stepLabel, stepNumber: rule.stepIndex + 1, of: last + 1 },
      },
      { session }
    );
    return updated;
  });
}

/**
 * The student answers a NEEDS_INFO request (optionally correcting the purpose). It returns
 * to the step that asked, so the same reviewer sees it again. Atomic like every transition.
 */
async function resubmit(student, requestId, { purpose } = {}) {
  const pre = await Request.findOne({ _id: requestId, studentId: student._id }, 'status currentStepIndex');
  if (!pre) throw new AppError(404, 'Request not found');
  if (pre.status !== S.NEEDS_INFO) {
    throw new AppError(409, `Invalid status transition: request is ${pre.status}, expected ${S.NEEDS_INFO}`);
  }
  const to = pre.currentStepIndex === 0 ? S.PENDING : S.UNDER_REVIEW;
  const set = { status: to };
  if (purpose !== undefined) set.purpose = purpose;
  const entry = { from: S.NEEDS_INFO, to, by: student._id, at: new Date(), note: 'Resubmitted by student' };

  return runInTransaction(async (session) => {
    const sessionOpt = session ? { session } : {};
    const updated = await Request.findOneAndUpdate(
      { _id: requestId, studentId: student._id, status: S.NEEDS_INFO, currentStepIndex: pre.currentStepIndex },
      { $set: set, $push: { statusHistory: entry } },
      { returnDocument: 'after', runValidators: true, ...sessionOpt }
    );
    if (!updated) throw new AppError(409, 'Invalid status transition: the request is no longer waiting for information');
    await audit.record(
      { actorId: student._id, action: 'REQUEST_RESUBMITTED', requestId: updated._id, details: { returnedTo: to } },
      { session }
    );
    return updated;
  });
}

/**
 * Completes whichever approval step the request is waiting on (the generic action the
 * UI uses). The target status follows from the step: UNDER_REVIEW, or APPROVED after the
 * last one. Everything else is the same atomic transition above.
 */
async function advance(actor, requestId) {
  const pre = await Request.findOne({ _id: requestId }, 'currentStepIndex workflowDefinitionId');
  const definition = pre ? await workflowService.getById(pre.workflowDefinitionId) : await workflowService.getCurrent();
  if (!pre) {
    // Same precedence as transition(): a role that can never advance gets 403, otherwise 404.
    const canAdvance = definition && buildRules(definition).some((r) => r.kind === 'advance' && r.role === actor.role);
    throw new AppError(canAdvance ? 404 : 403, canAdvance ? 'Request not found' : 'Access denied');
  }
  const last = definition.steps.length - 1;
  const to = pre.currentStepIndex < last ? S.UNDER_REVIEW : S.APPROVED;
  return transition(actor, requestId, to);
}

module.exports = { transition, resubmit, advance };
