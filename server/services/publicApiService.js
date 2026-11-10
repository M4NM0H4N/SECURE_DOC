'use strict';

const Request = require('../models/Request');
const workflowService = require('./workflowService');
const { REQUEST_STATUSES: S } = require('../config/constants');
const { contains, sortSpec, dateRange } = require('../utils/listQuery');

// What the read-only integration API reveals about a request: its kind, department, status, step and
// times. Never the student, the purpose, the staff who acted, the notes or any document.
const fulfilledAt = (r) => {
  const e = [...(r.statusHistory || [])].reverse().find((h) => h.to === S.FULFILLED);
  return e ? new Date(e.at).toISOString() : null;
};

function stepLabel(r, def) {
  if (r.status === S.APPROVED) return 'Awaiting document upload';
  if ([S.FULFILLED, S.REJECTED].includes(r.status)) return null;
  const step = def && def.steps[r.currentStepIndex];
  return step ? step.label : null;
}

function publicRequest(r, def) {
  return {
    id: String(r._id), documentType: r.documentType, department: r.department, status: r.status, currentStep: stepLabel(r, def),
    createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString(), fulfilledAt: fulfilledAt(r),
  };
}

async function listRequests({ status, department, documentType, q, from, to, sort, order, page = 1, limit = 50 }) {
  const filter = {};
  if (status) filter.status = status;
  if (department) filter.department = department;
  if (documentType) filter.documentType = documentType;
  if (q) filter.documentType = contains(q); // search is by document type only: purposes are personal text
  Object.assign(filter, dateRange('createdAt', from, to));
  const [found, total] = await Promise.all([
    Request.find(filter).sort(sortSpec({ sort, order, defaultSort: 'createdAt' })).skip((page - 1) * limit).limit(limit).lean(),
    Request.countDocuments(filter),
  ]);
  const defs = await workflowService.getMap(found.map((r) => r.workflowDefinitionId));
  return { items: found.map((r) => publicRequest(r, defs.get(String(r.workflowDefinitionId)))), total, page, limit };
}

async function getRequest(id) {
  const r = await Request.findOne({ _id: id }).lean();
  if (!r) return null;
  const def = await workflowService.getById(r.workflowDefinitionId);
  return {
    ...publicRequest(r, def),
    history: r.statusHistory.map((h) => ({ status: h.to, step: h.step || null, at: new Date(h.at).toISOString() })),
  };
}

module.exports = { listRequests, getRequest, publicRequest };
