'use strict';

const { body, param } = require('express-validator');

const id = param('id').isMongoId().withMessage('Invalid id');
const isActive = body('isActive').optional().isBoolean({ strict: true }).withMessage('isActive must be true or false');

const deptName = (chain) =>
  chain.isString().withMessage('Name must be text').bail().trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters');
const typeName = (chain) =>
  chain.isString().withMessage('Name must be text').bail().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2-80 characters');

const createDepartmentRules = [
  body('code')
    .isString().withMessage('Code must be text').bail()
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9]{2,10}$/).withMessage('Code must be 2-10 letters or digits'),
  deptName(body('name')),
];

const updateDepartmentRules = [
  id,
  body('code').not().exists().withMessage('The department code cannot be changed'),
  deptName(body('name').optional()),
  isActive,
];

const createDocumentTypeRules = [typeName(body('name'))];
const updateDocumentTypeRules = [id, typeName(body('name').optional()), isActive];

// Deep validation of each step lives in workflowEngine.normaliseSteps (single source of truth).
const workflowRules = [body('steps').isArray({ min: 1, max: 6 }).withMessage('steps must be a list of 1 to 6 approval steps')];

module.exports = {
  createDepartmentRules, updateDepartmentRules, createDocumentTypeRules, updateDocumentTypeRules, workflowRules,
};
