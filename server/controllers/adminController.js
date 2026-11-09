'use strict';

const userService = require('../services/userService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const auditService = require('../services/auditService');

const listUsers = asyncHandler(async (req, res) => {
  const { role, page, limit } = req.query;
  const result = await userService.listUsers({ role, page, limit });
  return ok(res, result);
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role, department } = req.body;
  const user = await userService.createStaff(req.user, { name, email, password, role, department });
  return ok(res, { user }, 201, 'Staff account created');
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, isActive, department } = req.body;
  const user = await userService.updateUser(req.user, req.params.id, { name, isActive, department });
  return ok(res, { user }, 200, 'User updated');
});

const listAuditLogs = asyncHandler(async (req, res) => {
  const { action, requestId, actorId, page, limit } = req.query;
  return ok(res, await auditService.listAuditLogs({ action, requestId, actorId, page, limit }));
});

module.exports = { listUsers, createUser, updateUser, listAuditLogs };
