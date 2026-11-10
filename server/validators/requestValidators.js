'use strict';

const { body, param, query } = require('express-validator');
const { REQUEST_STATUSES } = require('../config/constants');

const createRequestRules = [
  body('documentType')
    .isString().withMessage('Document type must be text').bail()
    .trim()
    .isLength({ min: 1, max: 80 }).withMessage('Document type is required'),
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

const needsInfoRules = [
  param('id').isMongoId().withMessage('Invalid request id'),
  body('note')
    .isString().withMessage('Tell the student what information is needed').bail()
    .trim()
    .isLength({ min: 5, max: 500 }).withMessage('The note must be 5-500 characters'),
];

const resubmitRules = [
  param('id').isMongoId().withMessage('Invalid request id'),
  body('purpose').optional()
    .isString().withMessage('Purpose must be text').bail()
    .trim()
    .isLength({ min: 10, max: 500 }).withMessage('Purpose must be 10-500 characters'),
];

module.exports.needsInfoRules = needsInfoRules;
module.exports.resubmitRules = resubmitRules;

const documentIdRules = [
  param('id').isMongoId().withMessage('Invalid request id'),
  param('docId').isMongoId().withMessage('Invalid document id'),
];
const revokeDocumentRules = [
  ...documentIdRules,
  body('reason')
    .isString().withMessage('A reason is required').bail()
    .trim()
    .isLength({ min: 5, max: 500 }).withMessage('The reason must be 5-500 characters'),
];
module.exports.documentIdRules = documentIdRules;
module.exports.revokeDocumentRules = revokeDocumentRules;
