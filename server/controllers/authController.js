'use strict';

const config = require('../config/env');
const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const auditService = require('../services/auditService');

// Explicit field picking: role/isActive from the body are never used.
const register = asyncHandler(async (req, res) => {
  const { name, email, password, department } = req.body;
  const user = await authService.registerStudent({ name, email, password, department });
  await auditService.recordSafe({ actorId: user._id, action: 'USER_REGISTERED' });
  return ok(res, { user }, 201, 'Registration successful');
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await authService.login(email, password);
  const token = authService.signToken(user._id, req.tenant._id);
  res.cookie(config.cookieName, token, authService.cookieOptions(req.tenant.slug));
  await auditService.recordSafe({ actorId: user._id, action: 'USER_LOGIN' });
  return ok(res, { user }, 200, 'Login successful');
});

const logout = (req, res) => {
  const opts = authService.cookieOptions(req.tenant.slug);
  delete opts.maxAge;
  res.clearCookie(config.cookieName, opts);
  return ok(res, undefined, 200, 'Logged out');
};

const me = (req, res) => ok(res, { user: req.user });

module.exports = { register, login, logout, me };
