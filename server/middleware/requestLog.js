'use strict';

const crypto = require('crypto');
const { logger } = require('../utils/logger');

// One access-log line per request: method, route PATTERN (not the URL), status, duration, a request id
// and the institution slug. Never the query string, body, headers, cookies or user identity beyond an id.
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

module.exports = function requestLog(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.set('X-Request-Id', id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
    const slug = req.params && req.params.slug;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      requestId: id,
      method: req.method,
      route: typeof route === 'string' ? route : 'pattern',
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      tenant: req.tenant ? req.tenant.slug : slug,
      userId: req.user ? String(req.user._id || req.user.id || '') : undefined,
    });
  });
  next();
};
