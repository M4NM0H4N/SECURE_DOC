'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const authService = require('../services/authService');
const accountService = require('../services/accountService');
const mfaService = require('../services/mfaService');
const lockout = require('../services/lockoutService');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok } = require('../utils/response');
const auditService = require('../services/auditService');
const { SECURITY } = require('../config/constants');

function startSession(req, res, user) {
  const token = authService.signToken(user._id, req.tenant._id, user.tokenVersion);
  res.cookie(config.cookieName, token, authService.cookieOptions(req.tenant.slug));
}

// Explicit field picking: role/isActive from the body are never used.
const register = asyncHandler(async (req, res) => {
  const { name, email, password, department } = req.body;
  const user = await authService.registerStudent({ name, email, password, department });
  await auditService.recordSafe({ actorId: user._id, action: 'USER_REGISTERED' });
  try {
    await accountService.sendVerification(user, req.tenant.slug);
  } catch (_err) {
    /* a mail problem must not fail registration; the student can ask for another link */
  }
  return ok(res, { user }, 201, 'Registration successful');
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await authService.login(email, password);
  await lockout.clearFailures(user);
  if (user.mfaEnabled) {
    // Password accepted, but no session yet: a short-lived challenge to be answered with a code.
    const challenge = jwt.sign({ sub: String(user._id), tid: String(req.tenant._id), ver: user.tokenVersion, mfa: true }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: SECURITY.MFA_CHALLENGE_TTL,
    });
    return ok(res, { mfaRequired: true, challenge }, 200, 'Enter your authentication code');
  }
  startSession(req, res, user);
  await auditService.recordSafe({ actorId: user._id, action: 'USER_LOGIN' });
  return ok(res, { user }, 200, 'Login successful');
});

// Second step of a login for accounts with MFA. Wrong codes count towards the same lockout.
const loginMfa = asyncHandler(async (req, res) => {
  const { challenge, code } = req.body;
  let payload;
  try {
    payload = jwt.verify(challenge, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_err) {
    throw new AppError(401, 'Your sign-in expired. Please start again.');
  }
  if (payload.mfa !== true || payload.tid !== String(req.tenant._id)) {
    throw new AppError(401, 'Your sign-in expired. Please start again.');
  }
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive || !user.mfaEnabled || payload.ver !== user.tokenVersion || lockout.isLocked(user)) {
    throw new AppError(401, 'Your sign-in expired. Please start again.');
  }
  if (!(await mfaService.verifyCode(user._id, code))) {
    await lockout.registerFailure(user);
    throw new AppError(401, 'That code is not valid');
  }
  await lockout.clearFailures(user);
  startSession(req, res, user);
  await auditService.recordSafe({ actorId: user._id, action: 'USER_LOGIN' });
  return ok(res, { user }, 200, 'Login successful');
});

// Logging out revokes the session on the server (a new token version), so a copied cookie is
// dead too. This signs the account out of every device.
const logout = asyncHandler(async (req, res) => {
  await accountService.revokeSessions(req.user._id);
  const opts = authService.cookieOptions(req.tenant.slug);
  delete opts.maxAge;
  res.clearCookie(config.cookieName, opts);
  return ok(res, undefined, 200, 'Logged out');
});

const me = (req, res) =>
  ok(res, {
    user: req.user,
    mfaAvailable: mfaService.available(),
    verificationRequired: config.requireEmailVerification,
  });

const changePassword = asyncHandler(async (req, res) => {
  const updated = await accountService.changePassword(req.user, req.body.currentPassword, req.body.newPassword);
  startSession(req, res, updated); // this device stays signed in; every other session ends
  return ok(res, undefined, 200, 'Password changed. Other devices have been signed out.');
});

// Same answer whether or not the address has an account.
const forgotPassword = asyncHandler(async (req, res) => {
  await accountService.requestReset(req.body.email, req.tenant.slug);
  return ok(res, undefined, 200, 'If that address has an account, a reset link has been sent.');
});

const resetPassword = asyncHandler(async (req, res) => {
  await accountService.resetPassword(req.body.token, req.body.password);
  return ok(res, undefined, 200, 'Password updated. You can sign in now.');
});

const verifyEmail = asyncHandler(async (req, res) => {
  await accountService.verifyEmail(req.body.token);
  return ok(res, undefined, 200, 'E-mail address verified');
});

const resendVerification = asyncHandler(async (req, res) => {
  await accountService.sendVerification(req.user, req.tenant.slug);
  return ok(res, undefined, 200, 'If your address still needs verifying, a new link has been sent.');
});

const peekInvite = asyncHandler(async (req, res) => {
  const invite = await accountService.peekInvite(req.query.token);
  return ok(res, { invite, institution: req.tenant.name });
});

const acceptInvite = asyncHandler(async (req, res) => {
  const { token, name, password } = req.body;
  const user = await accountService.acceptInvite(token, { name, password });
  return ok(res, { user }, 201, 'Account created. You can sign in now.');
});

const mfaSetup = asyncHandler(async (req, res) => ok(res, await mfaService.beginSetup(req.user)));
const mfaEnable = asyncHandler(async (req, res) => {
  const backupCodes = await mfaService.enable(req.user, req.body.code);
  return ok(res, { backupCodes }, 200, 'Multi-factor authentication is on. Save your backup codes now: they are shown only once.');
});
const mfaDisable = asyncHandler(async (req, res) => {
  await mfaService.disable(req.user, req.body.password, req.body.code);
  const opts = authService.cookieOptions(req.tenant.slug);
  delete opts.maxAge;
  res.clearCookie(config.cookieName, opts);
  return ok(res, undefined, 200, 'Multi-factor authentication is off. Please sign in again.');
});

module.exports = {
  register, login, loginMfa, logout, me, changePassword, forgotPassword, resetPassword, verifyEmail,
  resendVerification, peekInvite, acceptInvite, mfaSetup, mfaEnable, mfaDisable,
};
