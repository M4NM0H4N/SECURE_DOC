'use strict';

const { body, param, query } = require('express-validator');
const { ROLES } = require('../config/constants');
const { departmentCheck } = require('./authValidators');

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
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit').toInt(),
];

const { AUDIT_ACTIONS } = require('../config/constants');
const auditLogRules = [
  query('action').optional().isString().bail().isIn(AUDIT_ACTIONS).withMessage('Invalid action'),
  query('requestId').optional().isMongoId().withMessage('Invalid request id'),
  query('actorId').optional().isMongoId().withMessage('Invalid actor id'),
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit').toInt(),
];

module.exports = { updateUserRules, listUsersRules, auditLogRules };
