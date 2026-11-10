'use strict';

// Pure workflow logic: no database, no I/O. A definition is an ordered list of approval
// steps; everything the engine allows is derived from it.
//
//   step 0 completes  PENDING      -> UNDER_REVIEW   (or APPROVED when it is the last step)
//   step i completes  UNDER_REVIEW -> UNDER_REVIEW   (or APPROVED when it is the last step)
//   a step that canReject   -> REJECTED (reason required)
//   any step                -> NEEDS_INFO (note required); the student resubmits and the
//                              request returns to the same step
//   APPROVED  -> FULFILLED  (a Clerk of the request's department uploads the document)
//
// With the default definition this yields exactly the MVP's four transitions.
const { REQUEST_STATUSES: S, ROLES, WORKFLOW_STEP_ROLES, NOTIFY } = require('../config/constants');
const AppError = require('../utils/AppError');

function buildRules(definition) {
  const steps = definition.steps;
  const last = steps.length - 1;
  const rules = [];
  steps.forEach((step, i) => {
    const from = i === 0 ? S.PENDING : S.UNDER_REVIEW;
    const base = { from, stepIndex: i, role: step.role, departmentScoped: step.departmentScoped, stepLabel: step.label };
    rules.push({ ...base, kind: 'advance', to: i === last ? S.APPROVED : S.UNDER_REVIEW });
    if (step.canReject) rules.push({ ...base, kind: 'reject', to: S.REJECTED });
    rules.push({ ...base, kind: 'needs_info', to: S.NEEDS_INFO });
  });
  rules.push({
    kind: 'fulfil', from: S.APPROVED, stepIndex: last, to: S.FULFILLED,
    role: ROLES.CLERK, departmentScoped: true, stepLabel: 'Document upload',
  });
  return rules;
}

// Rules whose target and role match, ignoring where the request currently is.
const candidates = (rules, to, role) => rules.filter((r) => r.to === to && r.role === role);

// The one rule that applies to a request in this state, or null.
const ruleForState = (list, request) =>
  list.find((r) => r.from === request.status && r.stepIndex === request.currentStepIndex) || null;

// What the signed-in user may do with this request right now. Convenience for the UI only:
// the transition service re-checks everything on every action.
function availableActions(user, request, rules) {
  if (user.role === ROLES.STUDENT) {
    const own = String(request.studentId && request.studentId._id ? request.studentId._id : request.studentId) === String(user._id);
    return own && request.status === S.NEEDS_INFO ? ['resubmit'] : [];
  }
  const actions = [];
  for (const r of rules) {
    if (r.role !== user.role) continue;
    if (r.from !== request.status || r.stepIndex !== request.currentStepIndex) continue;
    if (r.departmentScoped && (!user.department || user.department !== request.department)) continue;
    actions.push(r.kind);
  }
  return actions;
}

const currentStepLabel = (definition, request) => {
  if (request.status === S.APPROVED) return 'Awaiting document upload';
  const step = definition.steps[request.currentStepIndex];
  return step && ![S.FULFILLED, S.REJECTED].includes(request.status) ? step.label : null;
};

function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'step';
}

// Validates admin input and returns normalised steps (keys and scope are derived, never trusted).
function normaliseSteps(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) {
    throw new AppError(400, 'A workflow needs 1 to 6 approval steps');
  }
  const used = new Set();
  const steps = input.map((raw, i) => {
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (label.length < 2 || label.length > 60) throw new AppError(400, `Step ${i + 1}: label must be 2-60 characters`);
    if (!WORKFLOW_STEP_ROLES.includes(raw.role)) {
      throw new AppError(400, `Step ${i + 1}: role must be one of ${WORKFLOW_STEP_ROLES.join(', ')}`);
    }
    if (raw.canReject !== undefined && typeof raw.canReject !== 'boolean') {
      throw new AppError(400, `Step ${i + 1}: canReject must be true or false`);
    }
    let key = slug(label);
    for (let n = 2; used.has(key); n += 1) key = `${slug(label)}-${n}`;
    used.add(key);
    let slaHours = null;
    if (raw.slaHours !== undefined && raw.slaHours !== null && raw.slaHours !== '') {
      if (!Number.isInteger(raw.slaHours) || raw.slaHours < 1 || raw.slaHours > NOTIFY.MAX_SLA_HOURS) {
        throw new AppError(400, `Step ${i + 1}: slaHours must be a whole number from 1 to ${NOTIFY.MAX_SLA_HOURS}`);
      }
      slaHours = raw.slaHours;
    }
    let escalateTo = null;
    if (raw.escalateTo !== undefined && raw.escalateTo !== null && raw.escalateTo !== '') {
      if (!WORKFLOW_STEP_ROLES.includes(raw.escalateTo)) throw new AppError(400, `Step ${i + 1}: escalateTo must be one of ${WORKFLOW_STEP_ROLES.join(', ')}`);
      if (slaHours === null) throw new AppError(400, `Step ${i + 1}: escalateTo needs slaHours`);
      if (raw.escalateTo === raw.role) throw new AppError(400, `Step ${i + 1}: escalate to a different role than the step's own`);
      escalateTo = raw.escalateTo;
    }
    return { key, label, role: raw.role, departmentScoped: raw.role !== ROLES.PRINCIPAL, canReject: raw.canReject === true, slaHours, escalateTo };
  });
  if (!steps.some((s) => s.canReject)) {
    throw new AppError(400, 'At least one step must be allowed to reject, otherwise a request can never be declined');
  }
  return steps;
}

// The SLA clock for a request that has just entered a step (at time `from`). Steps without an SLA have no
// timers. The reminder fires after REMINDER_FRACTION of the time, the escalation at the deadline.
function slaTimers(step, from = new Date()) {
  const base = { stepEnteredAt: from, slaReminderAt: null, slaDueAt: null };
  if (!step || !step.slaHours) return base;
  const ms = step.slaHours * 60 * 60 * 1000;
  return { stepEnteredAt: from, slaReminderAt: new Date(from.getTime() + ms * NOTIFY.REMINDER_FRACTION), slaDueAt: new Date(from.getTime() + ms) };
}
const NO_TIMERS = Object.freeze({ slaReminderAt: null, slaDueAt: null });

module.exports = { buildRules, candidates, ruleForState, availableActions, currentStepLabel, normaliseSteps, slaTimers, NO_TIMERS };
