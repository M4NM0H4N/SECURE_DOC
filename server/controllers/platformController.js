'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const authService = require('../services/authService');
const tenantService = require('../services/tenantService');
const audit = require('../services/auditService');
const { PLATFORM_COOKIE } = require('../middleware/authenticatePlatform');
const { runUnscoped } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const platformCookie = () => ({ ...authService.cookieOptions('platform'), path: '/api/platform' });

const signup = asyncHandler(async (req, res) => {
  const { institutionName, slug, adminName, adminEmail, adminPassword, signupKey } = req.body;
  const { tenant } = await tenantService.signup({ institutionName, slug, adminName, adminEmail, adminPassword, signupKey });
  return ok(res, { tenant: { name: tenant.name, slug: tenant.slug } }, 201, 'Institution created');
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await runUnscoped(() => User.findOne({ email, role: ROLES.SUPER_ADMIN }).select('+passwordHash'));
  const valid = await authService.verifyPassword(password, user ? user.passwordHash : authService.DUMMY_HASH);
  if (!user || !valid) throw new AppError(401, 'Invalid email or password');
  if (!user.isActive) throw new AppError(403, 'Account is deactivated');
  const token = jwt.sign({ sub: String(user._id), plat: true }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
  res.cookie(PLATFORM_COOKIE, token, platformCookie());
  await runUnscoped(() => audit.recordSafe({ actorId: user._id, action: 'PLATFORM_LOGIN' }));
  return ok(res, { user }, 200, 'Login successful');
});

const logout = (_req, res) => {
  const opts = platformCookie();
  delete opts.maxAge;
  res.clearCookie(PLATFORM_COOKIE, opts);
  return ok(res, undefined, 200, 'Logged out');
};

const tenants = asyncHandler(async (_req, res) => ok(res, { items: await tenantService.listTenants() }));

const lifecycle = require('../services/dataLifecycleService');
const suspend = asyncHandler(async (req, res) => ok(res, { tenant: tenantView(await lifecycle.suspend(req.params.slug, req.platformUser)) }, 200, 'Institution suspended'));
const resume = asyncHandler(async (req, res) => ok(res, { tenant: tenantView(await lifecycle.resume(req.params.slug, req.platformUser)) }, 200, 'Institution resumed'));
const remove = asyncHandler(async (req, res) => ok(res, await lifecycle.deleteInstitution(req.params.slug, req.body.confirm, req.platformUser), 200, 'Institution deleted'));
const tenantView = (t) => ({ name: t.name, slug: t.slug, status: t.status });

module.exports = { signup, login, logout, tenants, suspend, resume, remove };
