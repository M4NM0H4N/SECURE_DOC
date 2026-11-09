'use strict';

const Request = require('../models/Request');
const { ROLES, REQUEST_STATUSES } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');
const configService = require('./configService');
const workflowService = require('./workflowService');
const { buildRules, availableActions, currentStepLabel } = require('./workflowEngine');

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
          statusHistory: [{ from: null, to: REQUEST_STATUSES.PENDING, by: student._id, note: 'Request submitted' }],
        },
      ],
      session ? { session } : {}
    );
    await audit.record(
      { actorId: student._id, action: 'REQUEST_SUBMITTED', requestId: request._id, details: { documentType: typeName } },
      { session }
    );
    return request;
  });
}

// Adds what the UI needs to show the right buttons: which actions this user may take now and
// which approval step the request is waiting on. Plain objects, same shape as before plus two fields.
async function decorate(user, requests) {
  const defs = await workflowService.getMap(requests.map((r) => r.workflowDefinitionId));
  return requests.map((r) => {
    const obj = r.toJSON();
    const def = defs.get(String(r.workflowDefinitionId));
    obj.actions = def ? availableActions(user, r, buildRules(def)) : [];
    obj.currentStep = def ? currentStepLabel(def, r) : null;
    return obj;
  });
}

async function listRequests(user, { status, page = 1, limit = 20 }) {
  const filter = scopeFilter(user);
  if (status) filter.status = status;
  const [found, total] = await Promise.all([
    Request.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('studentId', 'name email department'),
    Request.countDocuments(filter),
  ]);
  return { items: await decorate(user, found), total, page, limit };
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

module.exports = { scopeFilter, createRequest, listRequests, getRequestForUser };
