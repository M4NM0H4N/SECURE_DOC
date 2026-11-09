'use strict';

const configService = require('../services/configService');
const workflowService = require('../services/workflowService');
const Request = require('../models/Request');
const { REQUEST_STATUSES: S } = require('../config/constants');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const brief = (d) => ({ _id: d._id, code: d.code, name: d.name });

// ---- Admin: departments ------------------------------------------------------------------
const listDepartments = asyncHandler(async (_req, res) => ok(res, { items: await configService.listDepartments({ includeInactive: true }) }));
const createDepartment = asyncHandler(async (req, res) => {
  const { code, name } = req.body;
  return ok(res, { department: await configService.createDepartment(req.user, { code, name }) }, 201, 'Department created');
});
const updateDepartment = asyncHandler(async (req, res) => {
  const { name, isActive } = req.body;
  return ok(res, { department: await configService.updateDepartment(req.user, req.params.id, { name, isActive }) }, 200, 'Department updated');
});

// ---- Admin: document types ---------------------------------------------------------------
const listDocumentTypes = asyncHandler(async (_req, res) => ok(res, { items: await configService.listDocumentTypes({ includeInactive: true }) }));
const createDocumentType = asyncHandler(async (req, res) => {
  return ok(res, { documentType: await configService.createDocumentType(req.user, { name: req.body.name }) }, 201, 'Document type created');
});
const updateDocumentType = asyncHandler(async (req, res) => {
  const { name, isActive } = req.body;
  return ok(res, { documentType: await configService.updateDocumentType(req.user, req.params.id, { name, isActive }) }, 200, 'Document type updated');
});

// ---- Admin: workflow ---------------------------------------------------------------------
async function describeWorkflow(definition) {
  const [warnings, olderInFlight] = await Promise.all([
    workflowService.rolesWithoutStaff(definition.steps),
    Request.countDocuments({
      workflowDefinitionId: { $ne: definition._id },
      status: { $in: [S.PENDING, S.UNDER_REVIEW, S.NEEDS_INFO, S.APPROVED] },
    }),
  ]);
  return {
    version: definition.version,
    steps: definition.steps,
    updatedAt: definition.createdAt,
    // Roles in the chain (or Clerk, for fulfilment) that have no active staff yet.
    rolesWithoutActiveStaff: warnings,
    // Requests still on an earlier version; they finish under the chain they started with.
    requestsOnOlderVersions: olderInFlight,
  };
}

const getWorkflow = asyncHandler(async (_req, res) => {
  const definition = await workflowService.requireCurrent();
  return ok(res, { workflow: await describeWorkflow(definition) });
});

const putWorkflow = asyncHandler(async (req, res) => {
  const definition = await workflowService.createVersion(req.user, req.body.steps);
  return ok(res, { workflow: await describeWorkflow(definition) }, 200, 'Workflow updated (new version; requests in progress keep their current chain)');
});

// ---- Pickers for forms -------------------------------------------------------------------
// Public: the registration form needs the institution's departments before anyone signs in.
const publicDepartments = asyncHandler(async (_req, res) => {
  return ok(res, { items: (await configService.listDepartments()).map(brief) });
});

// Signed-in: active departments and document types, plus the chain's step labels.
const options = asyncHandler(async (_req, res) => {
  const [departments, documentTypes, workflow] = await Promise.all([
    configService.listDepartments(),
    configService.listDocumentTypes(),
    workflowService.getCurrent(),
  ]);
  return ok(res, {
    departments: departments.map(brief),
    documentTypes: documentTypes.map((t) => t.name),
    steps: workflow ? workflow.steps.map((s) => ({ label: s.label, role: s.role })) : [],
  });
});

module.exports = {
  listDepartments, createDepartment, updateDepartment,
  listDocumentTypes, createDocumentType, updateDocumentType,
  getWorkflow, putWorkflow, publicDepartments, options,
};
