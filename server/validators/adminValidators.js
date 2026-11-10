'use strict';

const { body, param, query } = require('express-validator');
const { ROLES } = require('../config/constants');
const { departmentCheck } = require('./authValidators');
const { commonRules } = require('../utils/listQuery');

const updateUserRules = [
  param('id').isMongoId().withMessage('Invalid user id'),
  body('role').not().exists().withMessage('Role cannot be changed'),
  body('email').not().exists().withMessage('Email cannot be changed'),
  body('password').not().exists().withMessage('Password cannot be changed here'),
  body('name').optional()
    .isString().withMessage('Name must be text').bail()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('isActive').optional().isBoolean({ strict: true }).withMessage('isActive must be true or false'),
  departmentCheck(body('department').optional()),
];

const listUsersRules = [
  query('role').optional().isString().bail().isIn(Object.values(ROLES)).withMessage('Invalid role'),
  query('active').optional().isBoolean().withMessage('active must be true or false').toBoolean(),
  query('department').optional().isString().bail().trim().toUpperCase().matches(/^[A-Z0-9]{2,10}$/).withMessage('Invalid department'),
  ...commonRules({ sorts: ['createdAt', 'name', 'email', 'role'] }),
];

const { AUDIT_ACTIONS } = require('../config/constants');
const auditLogRules = [
  query('action').optional().isString().bail().isIn(AUDIT_ACTIONS).withMessage('Invalid action'),
  query('requestId').optional().isMongoId().withMessage('Invalid request id'),
  query('actorId').optional().isMongoId().withMessage('Invalid actor id'),
  ...commonRules({ sorts: ['timestamp', 'action', 'seq'] }),
];

module.exports = { updateUserRules, listUsersRules, auditLogRules };
