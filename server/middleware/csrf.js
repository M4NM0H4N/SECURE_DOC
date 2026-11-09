'use strict';

const AppError = require('../utils/AppError');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie auth + SameSite=Strict + required custom header. Browsers cannot add
// a custom header on cross-site requests without a CORS preflight, which we
// never approve, so forged cross-site form posts are rejected.
function requireCsrfHeader(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return next(new AppError(403, 'Missing CSRF header'));
  }
  next();
}

module.exports = requireCsrfHeader;
