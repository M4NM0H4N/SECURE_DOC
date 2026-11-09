'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const lockout = require('./lockoutService');
const AppError = require('../utils/AppError');

const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;
// Used to equalise timing when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// `ver` is the user's tokenVersion: bumping it (logout, password change/reset, deactivation,
// admin sign-out) invalidates every session issued before.
function signToken(userId, tenantId, ver = 0) {
  return jwt.sign({ sub: String(userId), tid: String(tenantId), ver }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
}

// The cookie is scoped to one institution's API path, so a browser never sends tenant A's
// session to tenant B.
function cookieOptions(slug) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    maxAge: config.cookieMaxAgeMs,
    path: `/api/t/${slug}`,
  };
}

// Role is fixed here, never read from input.
async function registerStudent({ name, email, password, department }) {
  const passwordHash = await hashPassword(password);
  return User.create({ name, email, passwordHash, role: ROLES.STUDENT, department });
}

async function login(email, password) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const hash = user ? user.passwordHash : DUMMY_HASH;
  const valid = await verifyPassword(password, hash);
  // Unknown account, locked account and wrong password all look identical to the caller.
  if (!user || lockout.isLocked(user)) {
    throw new AppError(401, 'Invalid email or password');
  }
  if (!valid) {
    await lockout.registerFailure(user);
    throw new AppError(401, 'Invalid email or password');
  }
  if (!user.isActive) {
    throw new AppError(403, 'Account is deactivated');
  }
  return user;
}

module.exports = {
  DUMMY_HASH,
  hashPassword,
  verifyPassword,
  signToken,
  cookieOptions,
  registerStudent,
  login,
};
