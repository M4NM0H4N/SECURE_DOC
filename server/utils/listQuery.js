'use strict';

const { query } = require('express-validator');

// Shared building blocks for every list: free-text search, sorting, date range, pagination.

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A case-insensitive "contains" matcher built from user text. The text is escaped, so it can never
// be a regular expression of its own (no injection, no catastrophic patterns), and it is length-capped.
const contains = (text) => new RegExp(escapeRegex(String(text).trim().slice(0, 80)), 'i');

// Validation rules every list shares. `sorts` are the fields a caller may sort by.
function commonRules({ sorts, maxLimit = 100 }) {
  return [
    query('q').optional().isString().bail().trim().isLength({ max: 80 }).withMessage('Search text is too long (80 characters at most)'),
    query('sort').optional().isString().bail().isIn(sorts).withMessage(`sort must be one of: ${sorts.join(', ')}`),
    query('order').optional().isString().bail().isIn(['asc', 'desc']).withMessage('order must be asc or desc'),
    query('from').optional().isISO8601().withMessage('from must be a date (YYYY-MM-DD)').toDate(),
    query('to').optional().isISO8601().withMessage('to must be a date (YYYY-MM-DD)').toDate(),
    query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
    query('limit').optional().isInt({ min: 1, max: maxLimit }).withMessage('Invalid limit').toInt(),
  ];
}

// { field: -1|1 } with a stable tie-break so pages never repeat or skip a row.
function sortSpec({ sort, order, defaultSort, defaultOrder = 'desc' }) {
  const field = sort || defaultSort;
  const dir = (order || defaultOrder) === 'asc' ? 1 : -1;
  return field === '_id' ? { _id: dir } : { [field]: dir, _id: dir };
}

// A createdAt-style range. `to` is inclusive of the whole day when only a date was given.
function dateRange(field, from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0) end.setUTCDate(end.getUTCDate() + 1);
    range.$lt = end;
  }
  return { [field]: range };
}

module.exports = { escapeRegex, contains, commonRules, sortSpec, dateRange };
