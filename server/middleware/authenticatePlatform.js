'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { runUnscoped } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const PLATFORM_COOKIE = `${config.cookieName}_platform`;

// SUPER_ADMIN session: its own cookie (scoped to /api/platform) and a `plat` claim.
// A tenant token has no `plat` claim and a platform token has no `tid`, so neither
// works on the other's routes.
const authenticatePlatform = asyncHandler(async (req, _res, next) => {
  const token = req.cookies && req.cookies[PLATFORM_COOKIE];
  if (typeof token !== 'string' || !token) throw new AppError(401, 'Authentication required');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_err) {
    throw new AppError(401, 'Invalid or expired session');
  }
  if (payload.plat !== true) throw new AppError(401, 'Invalid or expired session');

  const user = await runUnscoped(() => User.findOne({ _id: payload.sub, role: ROLES.SUPER_ADMIN }));
  if (!user) throw new AppError(401, 'Invalid or expired session');
  if (!user.isActive) throw new AppError(403, 'Account is deactivated');
  req.platformUser = user;
  next();
});

module.exports = authenticatePlatform;
module.exports.PLATFORM_COOKIE = PLATFORM_COOKIE;
