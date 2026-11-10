'use strict';

// Aggregate numbers only (no names, purposes or documents): the Admin and the Principal.
const router = require('express').Router();
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const { ROLES } = require('../config/constants');
const { query } = require('express-validator');
const analytics = require('../services/analyticsService');
const { sendCsv } = require('../utils/csv');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const rules = [
  query('from').optional().isISO8601().withMessage('from must be a date (YYYY-MM-DD)').toDate(),
  query('to').optional().isISO8601().withMessage('to must be a date (YYYY-MM-DD)').toDate(),
];

router.use(authenticate, authorize(ROLES.ADMIN, ROLES.PRINCIPAL));

router.get('/summary', rules, validate, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  return ok(res, await analytics.summary({ from: req.query.from, to: req.query.to }));
}));

router.get('/summary.csv', rules, validate, asyncHandler(async (req, res) => {
  const s = await analytics.summary({ from: req.query.from, to: req.query.to });
  sendCsv(res, `summary-${new Date().toISOString().slice(0, 10)}.csv`, ['metric', 'value'], analytics.summaryRows(s));
}));

module.exports = router;
