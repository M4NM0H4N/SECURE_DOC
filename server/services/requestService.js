'use strict';

const Request = require('../models/Request');
const User = require('../models/User');
const { contains, sortSpec, dateRange } = require('../utils/listQuery');
const { MAX_EXPORT_ROWS } = require('../utils/csv');
const Document = require('../models/Document');
const { ROLES, REQUEST_STATUSES } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');
const configService = require('./configService');
const workflowService = require('./workflowService');
const { buildRules, availableActions, currentStepLabel, slaTimers } = require('./workflowEngine');
const notifications = require('./notificationService');
const webhooks = require('./webhookService');

// Single source of truth for "which requests may this user see" (always inside the user's
// institution, which the tenant plugin adds to every query).
//  - Student: only their own
//  - Clerk / HOD: only their own department
//  - Principal / Admin: all of the institution's requests (read-only for Admin)
function scopeFilter(user) {
  switch (user.role) {
    case ROLES.STUDENT:
      return { studentId: user._id };
    case ROLES.CLERK:
    case ROLES.HOD:
      if (!user.department) throw new AppError(403, 'Access denied');
      return { department: user.department };
    case ROLES.PRINCIPAL:
    case ROLES.ADMIN:
      return {};
    default:
      throw new AppError(403, 'Access denied');
  }
}

async function createRequest(student, { documentType, purpose }) {
  // Department, status, studentId and the workflow version are set here, never from the client.
  const typeName = await configService.resolveActiveDocumentType(documentType);
  if (!typeName) throw new AppError(400, 'Unknown or inactive document type');

  return runInTransaction(async (session) => {
    const definition = await workflowService.requireCurrent(session);
    const [request] = await Request.create(
      [
        {
          studentId: student._id,
          department: student.department,
          documentType: typeName,
          purpose,
          status: REQUEST_STATUSES.PENDING,
          workflowDefinitionId: definition._id,
          currentStepIndex: 0,
          ...slaTimers(definition.steps[0], new Date()),
          statusHistory: [{ from: null, to: REQUEST_STATUSES.PENDING, by: student._id, note: 'Request submitted' }],
        },
      ],
      session ? { session } : {}
    );
    await audit.record(
      { actorId: student._id, action: 'REQUEST_SUBMITTED', requestId: request._id, details: { documentType: typeName } },
      { session }
    );
    await notifications.onSubmitted({ request, definition, session });
    await webhooks.emit(
      'request.submitted',
      { requestId: String(request._id), documentType: request.documentType, department: request.department, status: request.status },
      { session, key: `submitted:${request._id}` }
    );
    return request;
  });
}

// Adds what the UI needs to show the right buttons: which actions this user may take now and
// which approval step the request is waiting on. Plain objects, same shape as before plus two fields.
async function decorate(user, requests) {
  const defs = await workflowService.getMap(requests.map((r) => r.workflowDefinitionId));
  // How many active documents each request has (one tenant-scoped query), so the UI can show downloads.
  const counts = new Map(
    (requests.length
      ? await Document.aggregate([{ $match: { requestId: { $in: requests.map((r) => r._id) }, status: 'ACTIVE' } }, { $group: { _id: '$requestId', n: { $sum: 1 } } }])
      : []
    ).map((c) => [String(c._id), c.n])
  );
  return requests.map((r) => {
    const obj = r.toJSON();
    obj.documentCount = counts.get(String(r._id)) || 0;
    const def = defs.get(String(r.workflowDefinitionId));
    obj.actions = def ? availableActions(user, r, buildRules(def)) : [];
    obj.currentStep = def ? currentStepLabel(def, r) : null;
    return obj;
  });
}

const SORTABLE = ['createdAt', 'updatedAt', 'status', 'documentType'];

// The filter for a list: the user's scope ALWAYS applies, and every extra filter only narrows it
// (a Clerk asking for another department gets nothing, never that department's requests).
// Returns null when the combination can match nothing.
async function listFilter(user, { status, department, documentType, q, from, to }) {
  const filter = scopeFilter(user);
  if (status) filter.status = status;
  if (department) {
    if (filter.department && filter.department !== department) return null;
    filter.department = department;
  }
  if (documentType) filter.documentType = documentType;
  Object.assign(filter, dateRange('createdAt', from, to));
  if (q) {
    const rx = contains(q);
    const or = [{ purpose: rx }, { documentType: rx }];
    // Staff can also search by the student's name or e-mail (students only ever see their own).
    if (user.role !== ROLES.STUDENT) {
      const students = await User.find({ role: ROLES.STUDENT, $or: [{ name: rx }, { email: rx }] }, '_id').limit(200);
      if (students.length) or.push({ studentId: { $in: students.map((s) => s._id) } });
    }
    filter.$or = or;
  }
  return filter;
}

async function listRequests(user, params) {
  const { page = 1, limit = 20, sort, order } = params;
  const filter = await listFilter(user, params);
  if (!filter) return { items: [], total: 0, page, limit };
  const [found, total] = await Promise.all([
    Request.find(filter)
      .sort(sortSpec({ sort, order, defaultSort: 'createdAt' }))
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('studentId', 'name email department'),
    Request.countDocuments(filter),
  ]);
  return { items: await decorate(user, found), total, page, limit };
}

// Everything the same filters match, for a spreadsheet (capped). Students get no names column.
async function exportRequests(user, params) {
  const filter = await listFilter(user, params);
  if (!filter) return { rows: [], truncated: false, header: [] };
  const found = await Request.find(filter)
    .sort(sortSpec({ sort: params.sort, order: params.order, defaultSort: 'createdAt' }))
    .limit(MAX_EXPORT_ROWS + 1)
    .populate('studentId', 'name');
  const truncated = found.length > MAX_EXPORT_ROWS;
  const staff = user.role !== ROLES.STUDENT;
  const header = ['id', 'submitted', 'updated', 'document type', 'department', 'status', ...(staff ? ['student'] : [])];
  const rows = found.slice(0, MAX_EXPORT_ROWS).map((x) => [
    String(x._id), x.createdAt, x.updatedAt, x.documentType, x.department, x.status,
    ...(staff ? [x.studentId && x.studentId.name ? x.studentId.name : ''] : []),
  ]);
  return { header, rows, truncated };
}

// Out-of-scope and non-existent requests both return 404 so existence is not leaked.
async function getRequestForUser(user, id) {
  const request = await Request.findOne({ _id: id, ...scopeFilter(user) })
    .populate('studentId', 'name email department')
    .populate('statusHistory.by', 'name role');
  if (!request) throw new AppError(404, 'Request not found');
  const [decorated] = await decorate(user, [request]);
  return decorated;
}

module.exports = { scopeFilter, createRequest, listRequests, exportRequests, getRequestForUser, SORTABLE };
