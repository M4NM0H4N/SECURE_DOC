'use strict';

const Request = require('../models/Request');
const { ROLES, REQUEST_STATUSES } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');

// Single source of truth for "which requests may this user see".
//  - Student: only their own
//  - Clerk / HOD: only their own department
//  - Admin: all (read-only metadata; no workflow powers)
function scopeFilter(user) {
  switch (user.role) {
    case ROLES.STUDENT:
      return { studentId: user._id };
    case ROLES.CLERK:
    case ROLES.HOD:
      if (!user.department) throw new AppError(403, 'Access denied');
      return { department: user.department };
    case ROLES.ADMIN:
      return {};
    default:
      throw new AppError(403, 'Access denied');
  }
}

async function createRequest(student, { documentType, purpose }) {
  // Department, status and studentId are set here, never from the client.
  return runInTransaction(async (session) => {
    const [request] = await Request.create(
      [
        {
          studentId: student._id,
          department: student.department,
          documentType,
          purpose,
          status: REQUEST_STATUSES.PENDING,
          statusHistory: [{ from: null, to: REQUEST_STATUSES.PENDING, by: student._id, note: 'Request submitted' }],
        },
      ],
      session ? { session } : {}
    );
    await audit.record(
      { actorId: student._id, action: 'REQUEST_SUBMITTED', requestId: request._id, details: { documentType } },
      { session }
    );
    return request;
  });
}

async function listRequests(user, { status, page = 1, limit = 20 }) {
  const filter = scopeFilter(user);
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Request.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('studentId', 'name email department'),
    Request.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

// Out-of-scope and non-existent requests both return 404 so existence is not leaked.
async function getRequestForUser(user, id) {
  const request = await Request.findOne({ _id: id, ...scopeFilter(user) })
    .populate('studentId', 'name email department')
    .populate('statusHistory.by', 'name role');
  if (!request) throw new AppError(404, 'Request not found');
  return request;
}

module.exports = { scopeFilter, createRequest, listRequests, getRequestForUser };
