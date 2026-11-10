'use strict';

// Read-only integration API (v1), under /api/t/<slug>/v1. Authenticated by an institution API key in
// the Authorization header (never a cookie, so there is no CSRF surface), limited by scope, rate
// limited per key. It reveals no personal data; see publicApiService.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { param } = require('express-validator');
const authenticateApiKey = require('../middleware/authenticateApiKey');
const validate = require('../middleware/validate');
const publicApi = require('../services/publicApiService');
const analytics = require('../services/analyticsService');
const { commonRules } = require('../utils/listQuery');
const { REQUEST_STATUSES } = require('../config/constants');
const { buildSpec } = require('../openapi');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const { query } = require('express-validator');

module.exports = function createApiV1Router({ max = 300 } = {}) {
  const router = express.Router({ mergeParams: true });

  // The description needs no key (it describes the API; it contains no data).
  router.get('/openapi.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildSpec());
  });

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.prefix}` : 'anonymous'),
    message: { success: false, message: 'Too many requests for this API key. Please slow down.' },
  });

  const listRules = [
    query('status').optional().isIn(Object.values(REQUEST_STATUSES)).withMessage('Invalid status'),
    query('department').optional().isString().bail().trim().toUpperCase().matches(/^[A-Z0-9]{2,10}$/).withMessage('Invalid department'),
    query('documentType').optional().isString().bail().trim().isLength({ min: 1, max: 80 }).withMessage('Invalid document type'),
    ...commonRules({ sorts: ['createdAt', 'updatedAt', 'status', 'documentType'] }),
  ];

  router.get('/requests', authenticateApiKey('requests:read'), limiter, listRules, validate, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    return ok(res, await publicApi.listRequests(req.query));
  }));

  router.get('/requests/:id', authenticateApiKey('requests:read'), limiter, param('id').isMongoId().withMessage('Invalid request id'), validate, asyncHandler(async (req, res) => {
    const r = await publicApi.getRequest(req.params.id);
    if (!r) throw new AppError(404, 'Request not found');
    res.set('Cache-Control', 'private, no-store');
    return ok(res, { request: r });
  }));

  router.get(
    '/analytics/summary',
    authenticateApiKey('analytics:read'), limiter,
    query('from').optional().isISO8601().withMessage('from must be a date (YYYY-MM-DD)').toDate(),
    query('to').optional().isISO8601().withMessage('to must be a date (YYYY-MM-DD)').toDate(),
    validate,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      return ok(res, await analytics.summary({ from: req.query.from, to: req.query.to }));
    })
  );

  return router;
};
