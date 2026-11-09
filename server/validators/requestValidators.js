'use strict';

const { body, param, query } = require('express-validator');
const { DOCUMENT_TYPES, REQUEST_STATUSES } = require('../config/constants');

const createRequestRules = [
  body('documentType')
    .isString().withMessage('Document type must be text').bail()
    .isIn(DOCUMENT_TYPES).withMessage(`Document type must be one of: ${DOCUMENT_TYPES.join(', ')}`),
  body('purpose')
    .isString().withMessage('Purpose must be text').bail()
    .trim()
    .isLength({ min: 10, max: 500 }).withMessage('Purpose must be 10-500 characters'),
];

const requestIdRule = [param('id').isMongoId().withMessage('Invalid request id')];

const listRequestsRules = [
  query('status').optional()
    .isString().bail()
    .isIn(Object.values(REQUEST_STATUSES)).withMessage('Invalid status'),
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit').toInt(),
];

module.exports = { createRequestRules, requestIdRule, listRequestsRules };

// Rejection must carry a real reason (whitespace-only is not a reason).
const rejectRules = [
  param('id').isMongoId().withMessage('Invalid request id'),
  body('reason')
    .isString().withMessage('A rejection reason is required').bail()
    .trim()
    .isLength({ min: 5, max: 500 }).withMessage('Rejection reason must be 5-500 characters'),
];

module.exports.rejectRules = rejectRules;
