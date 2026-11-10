'use strict';

const crypto = require('crypto');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { REQUEST_STATUSES: S, ROLES } = require('../config/constants');
const AppError = require('../utils/AppError');
const mailer = require('./mailer');
const audit = require('./auditService');

const opt = (session) => (session ? { session } : {});

// ---- who is told ----------------------------------------------------------------------------
// Active staff who own a role, within the request's department for department-scoped roles.
function staffWithRole(role, department, session) {
  const filter = { role, isActive: true };
  if (role !== ROLES.PRINCIPAL) filter.department = department;
  return User.find(filter, '_id email name notifyEmail isActive').session(session || null);
}
const stepOwners = (step, department, session) => staffWithRole(step.role, department, session);

const loadUser = (id, session) => User.findOne({ _id: id, isActive: true }, '_id email name notifyEmail isActive').session(session || null);

// ---- writing --------------------------------------------------------------------------------
/**
 * Creates the in-app notification (already delivered) and, when mail is on and the person has not
 * opted out, the e-mail outbox entry. Both are upserts on a unique key, so doing the same thing
 * twice (a retried job, two workers) never produces two messages. Pass the caller's session so the
 * notification commits or rolls back together with the event that caused it.
 */
async function enqueue({ recipient, type, title, body, template, data = {}, requestId = null, dedupe, session }) {
  const now = new Date();
  const base = { userId: recipient._id, type, title, body, requestId, template, data };
  await Notification.updateOne(
    { dedupeKey: `${dedupe}:app:${recipient._id}` },
    { $setOnInsert: { ...base, channel: 'IN_APP', status: 'SENT', sentAt: now, notBefore: now } },
    { upsert: true, ...opt(session) }
  );
  if (mailer.enabled() && recipient.notifyEmail !== false) {
    await Notification.updateOne(
      { dedupeKey: `${dedupe}:mail:${recipient._id}` },
      { $setOnInsert: { ...base, channel: 'EMAIL', status: 'PENDING', notBefore: now } },
      { upsert: true, ...opt(session) }
    );
  }
}

const label = (r) => r.documentType;

async function studentName(request, session) {
  const u = await User.findOne({ _id: request.studentId }, 'name').session(session || null);
  return u ? u.name : 'A student';
}

// A request has just been submitted: the owners of step 1 are told.
async function onSubmitted({ request, definition, session }) {
  const step = definition.steps[0];
  const name = await studentName(request, session);
  for (const staff of await stepOwners(step, request.department, session)) {
    await enqueue({
      recipient: staff, type: 'REQUEST_SUBMITTED', title: 'New request to review', body: `${label(request)} from ${name}`,
      template: 'request-submitted', data: { documentType: label(request), studentName: name, stepLabel: step.label },
      requestId: request._id, dedupe: `submitted:${request._id}`, session,
    });
  }
}

// A request has just been through one transition. Each outcome tells exactly the right people.
async function onTransition({ request, to, definition, session }) {
  const id = request._id;
  const history = request.statusHistory.length; // distinguishes repeated moves of the same kind
  const student = () => loadUser(request.studentId, session);

  if (to === S.UNDER_REVIEW) {
    const step = definition.steps[request.currentStepIndex];
    const name = await studentName(request, session);
    for (const staff of await stepOwners(step, request.department, session)) {
      await enqueue({
        recipient: staff, type: 'STEP_WAITING', title: 'A request is waiting for you', body: `${label(request)} from ${name} (${step.label})`,
        template: 'step-waiting', data: { documentType: label(request), studentName: name, stepLabel: step.label },
        requestId: id, dedupe: `step:${id}:${request.currentStepIndex}:${history}`, session,
      });
    }
    return;
  }
  if (to === S.APPROVED) {
    const s = await student();
    if (s) {
      await enqueue({
        recipient: s, type: 'REQUEST_APPROVED', title: 'Your request was approved', body: `${label(request)}: the office will prepare your document`,
        template: 'request-approved', data: { documentType: label(request) }, requestId: id, dedupe: `approved:${id}`, session,
      });
    }
    const name = await studentName(request, session);
    for (const clerk of await staffWithRole(ROLES.CLERK, request.department, session)) {
      await enqueue({
        recipient: clerk, type: 'APPROVED_UPLOAD', title: 'Approved: upload the document', body: `${label(request)} from ${name}`,
        template: 'request-approved-upload', data: { documentType: label(request), studentName: name }, requestId: id, dedupe: `approved-upload:${id}`, session,
      });
    }
    return;
  }
  const s = await student();
  if (!s) return;
  if (to === S.REJECTED) {
    await enqueue({
      recipient: s, type: 'REQUEST_REJECTED', title: 'Your request was not approved', body: label(request),
      template: 'request-rejected', data: { documentType: label(request), reason: request.rejectionReason }, requestId: id, dedupe: `rejected:${id}`, session,
    });
  } else if (to === S.NEEDS_INFO) {
    const entry = [...request.statusHistory].reverse().find((h) => h.to === S.NEEDS_INFO);
    await enqueue({
      recipient: s, type: 'NEEDS_INFO', title: 'More information is needed', body: label(request),
      template: 'request-needs-info', data: { documentType: label(request), note: entry ? entry.note : '' }, requestId: id, dedupe: `needs-info:${id}:${history}`, session,
    });
  } else if (to === S.FULFILLED) {
    await enqueue({
      recipient: s, type: 'REQUEST_FULFILLED', title: 'Your document is ready', body: label(request),
      template: 'request-fulfilled', data: { documentType: label(request) }, requestId: id, dedupe: `fulfilled:${id}`, session,
    });
  }
}

// The student answered a question: the owners of the step that asked are told.
async function onResubmitted({ request, definition, session }) {
  const step = definition.steps[request.currentStepIndex];
  const name = await studentName(request, session);
  for (const staff of await stepOwners(step, request.department, session)) {
    await enqueue({
      recipient: staff, type: 'REQUEST_RESUBMITTED', title: 'Information received', body: `${label(request)} from ${name}`,
      template: 'request-resubmitted', data: { documentType: label(request), studentName: name, stepLabel: step.label },
      requestId: request._id, dedupe: `resubmitted:${request._id}:${request.statusHistory.length}`, session,
    });
  }
}

// SLA reminder or escalation for the step a request is waiting at (see slaService).
async function onSla({ kind, request, step, session }) {
  const escalation = kind === 'escalation';
  const role = escalation && step.escalateTo ? step.escalateTo : step.role;
  const name = await studentName(request, session);
  const stamp = request.stepEnteredAt ? request.stepEnteredAt.getTime() : 0;
  for (const staff of await staffWithRole(role, request.department, session)) {
    await enqueue({
      recipient: staff, type: escalation ? 'SLA_ESCALATION' : 'SLA_REMINDER',
      title: escalation ? 'Overdue request' : 'A request is due soon', body: `${label(request)} from ${name} (${step.label})`,
      template: escalation ? 'sla-escalation' : 'sla-reminder', data: { documentType: label(request), studentName: name, stepLabel: step.label },
      requestId: request._id, dedupe: `sla-${kind}:${request._id}:${request.currentStepIndex}:${stamp}`, session,
    });
  }
}

// Delivery record for security mail (invite, reset, verification). The link is NOT stored: only
// that a message was sent, to whom, and whether it worked.
async function recordSecurityMail({ type, userId = null, ok, error = null }) {
  await Notification.create({
    userId, channel: 'EMAIL', type, template: null, dedupeKey: `security:${crypto.randomUUID()}`,
    status: ok ? 'SENT' : 'FAILED', attempts: ok ? 1 : 2, sentAt: ok ? new Date() : null,
    lastError: ok ? null : String(error || 'delivery failed').slice(0, 200),
  });
}

// ---- reading (a person's own in-app notifications) ------------------------------------------
async function listMine(user, { unread = false, page = 1, limit = 20 } = {}) {
  const filter = { userId: user._id, channel: 'IN_APP' };
  if (unread) filter.readAt = null;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: user._id, channel: 'IN_APP', readAt: null }),
  ]);
  return { items, total, unreadCount, page, limit };
}

async function markRead(user, id) {
  const res = await Notification.updateOne({ _id: id, userId: user._id, channel: 'IN_APP' }, { $set: { readAt: new Date() } });
  if (res.matchedCount === 0) throw new AppError(404, 'Notification not found');
}
async function markAllRead(user) {
  await Notification.updateMany({ userId: user._id, channel: 'IN_APP', readAt: null }, { $set: { readAt: new Date() } });
}
async function setPreferences(user, { email }) {
  await User.updateOne({ _id: user._id }, { $set: { notifyEmail: email } });
}

// ---- the Admin's delivery log ---------------------------------------------------------------
// E-mail rows only; never the content or any link. Recipient shown by name and role.
async function listDeliveries({ status, type, page = 1, limit = 50 } = {}) {
  const filter = { channel: 'EMAIL' };
  if (status) filter.status = status;
  if (type) filter.type = type;
  const [rows, total] = await Promise.all([
    Notification.find(filter, 'userId channel type status attempts lastError sentAt notBefore createdAt requestId')
      .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'name role'),
    Notification.countDocuments(filter),
  ]);
  const items = rows.map((n) => {
    const o = n.toJSON();
    o.recipient = n.userId && n.userId.name ? { name: n.userId.name, role: n.userId.role } : null;
    delete o.userId;
    return o;
  });
  return { items, total, page, limit };
}

// A FAILED e-mail can be tried again by hand. Security mail has no stored content to resend.
async function retry(actor, id) {
  const n = await Notification.findOne({ _id: id, channel: 'EMAIL' });
  if (!n) throw new AppError(404, 'Notification not found');
  if (n.status !== 'FAILED') throw new AppError(409, `Only a failed message can be retried (this one is ${n.status})`);
  if (!n.template) throw new AppError(409, 'This was a security message; ask for a fresh invitation or reset link instead');
  const res = await Notification.updateOne({ _id: id, status: 'FAILED' }, { $set: { status: 'PENDING', attempts: 0, notBefore: new Date(), lockedAt: null, lastError: null } });
  if (res.modifiedCount !== 1) throw new AppError(409, 'This message was changed by someone else');
  await audit.recordSafe({ actorId: actor._id, action: 'NOTIFICATION_RETRIED', details: { notificationId: String(id) } });
}

module.exports = {
  enqueue, onSubmitted, onTransition, onResubmitted, onSla, recordSecurityMail,
  listMine, markRead, markAllRead, setPreferences, listDeliveries, retry, staffWithRole, stepOwners, loadUser,
};
