'use strict';

const AppError = require('../utils/AppError');

// Role gate. Resource-level checks (ownership, department) live in services.
const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Access denied'));
    }
    next();
  };

module.exports = authorize;
