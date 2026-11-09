'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// Verifies the JWT cookie, then re-loads the user so deactivation and role
// changes take effect immediately (not at token expiry).
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = req.cookies && req.cookies[config.cookieName];
  if (typeof token !== 'string' || !token) {
    throw new AppError(401, 'Authentication required');
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_err) {
    throw new AppError(401, 'Invalid or expired session');
  }

  // The session belongs to one institution. A token from another tenant (or a platform
  // token) is rejected, even if the user id exists, so sessions never cross tenants.
  if (!req.tenant || typeof payload.tid !== 'string' || payload.tid !== String(req.tenant._id)) {
    throw new AppError(401, 'Invalid or expired session');
  }

  // A pending MFA challenge is not a session.
  if (payload.mfa === true) throw new AppError(401, 'Invalid or expired session');

  const user = await User.findById(payload.sub);
  if (!user) {
    throw new AppError(401, 'Invalid or expired session');
  }
  // Server-side revocation: logout, password change/reset, deactivation and admin sign-out
  // bump tokenVersion, so every older token stops working immediately. (Checked after the
  // active flag so a deactivated user still gets the explanatory 403; reactivating them does
  // not bring their old sessions back, because the version no longer matches.)
  if (!user.isActive) {
    throw new AppError(403, 'Account is deactivated');
  }
  if (payload.ver !== user.tokenVersion) {
    throw new AppError(401, 'Invalid or expired session');
  }

  req.user = user;
  next();
});

module.exports = authenticate;
