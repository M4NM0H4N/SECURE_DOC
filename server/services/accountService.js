'use strict';

const config = require('../config/env');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Invite = require('../models/Invite');
const AuthToken = require('../models/AuthToken');
const { STAFF_ROLES, DEPARTMENT_ROLES, SECURITY } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const { newToken, hashToken, looksLikeToken } = require('../utils/tokens');
const authService = require('./authService');
const configService = require('./configService');
const audit = require('./auditService');
const mailer = require('./mailer');
const notifications = require('./notificationService');

const INVALID_LINK = 'This link is invalid or has expired';
const link = (slug, page, token) => `${config.publicUrl}/t/${slug}/${page}?token=${token}`;
const inFuture = (ms) => new Date(Date.now() + ms);

// Mail problems must never change what the caller sees (and never expose a link in an error).
// Security mail carries a secret link, so it is sent straight away (one retry) rather than queued: a
// stored copy would keep the link in the database. Whether it worked is recorded WITHOUT the link, so
// an Admin can see a failed invitation and hand the link over instead. Does nothing when mail is off.
const SECURITY_TYPES = { 'staff-invite': 'SECURITY_INVITE', 'password-reset': 'SECURITY_RESET', 'verify-email': 'SECURITY_VERIFY' };
async function sendQuietly(message, { userId = null } = {}) {
  if (!mailer.enabled()) return;
  // Name the institution in the message (taken from the slug in the link, never from user input).
  const slug = /\/t\/([a-z0-9-]+)\//.exec((message.data && message.data.link) || '');
  if (slug) {
    const tenant = await Tenant.findOne({ slug: slug[1] }, 'name');
    if (tenant) message = { ...message, data: { ...message.data, institution: tenant.name } };
  }
  let error = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mailer.send(message);
      error = null;
      break;
    } catch (err) {
      error = (err && err.message) || 'delivery failed';
    }
  }
  try {
    await notifications.recordSecurityMail({ type: SECURITY_TYPES[message.template] || 'SECURITY_OTHER', userId, ok: !error, error });
  } catch (_err) {
    /* the record is best effort */
  }
}

// ---- sessions ----------------------------------------------------------------------------
// Bumping tokenVersion invalidates every session issued so far.
const revokeSessions = (userId) => User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });

async function changePassword(user, currentPassword, newPassword) {
  const full = await User.findById(user._id).select('+passwordHash');
  if (!(await authService.verifyPassword(currentPassword, full.passwordHash))) {
    throw new AppError(400, 'Your current password is not correct');
  }
  if (await authService.verifyPassword(newPassword, full.passwordHash)) {
    throw new AppError(400, 'Choose a password you have not used just now');
  }
  const passwordHash = await authService.hashPassword(newPassword);
  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $set: { passwordHash, passwordChangedAt: new Date() }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' }
  );
  await audit.recordSafe({ actorId: user._id, action: 'PASSWORD_CHANGED' });
  return updated; // the caller issues a fresh session; every other session is now invalid
}

// ---- password reset ----------------------------------------------------------------------
async function issueResetToken(user, slug) {
  await AuthToken.updateMany({ userId: user._id, type: 'RESET', usedAt: null }, { $set: { usedAt: new Date() } });
  const token = newToken();
  await AuthToken.create({ userId: user._id, type: 'RESET', tokenHash: hashToken(token), expiresAt: inFuture(SECURITY.RESET_TTL_MS) });
  return link(slug, 'reset-password.html', token);
}

// Always succeeds from the caller's point of view: the response never says whether the
// address has an account.
async function requestReset(email, slug) {
  const user = await User.findOne({ email, isActive: true });
  if (!user) return;
  const url = await issueResetToken(user, slug);
  await sendQuietly({ to: user.email, template: 'password-reset', data: { link: url, name: user.name } }, { userId: user._id });
}

async function resetPassword(token, newPassword) {
  if (!looksLikeToken(token)) throw new AppError(400, INVALID_LINK);
  // Single use, enforced by the atomic update: only one caller can flip usedAt.
  const used = await AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(token), type: 'RESET', usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } }
  );
  if (!used) throw new AppError(400, INVALID_LINK);
  const user = await User.findOne({ _id: used.userId, isActive: true });
  if (!user) throw new AppError(400, INVALID_LINK);
  const passwordHash = await authService.hashPassword(newPassword);
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null }, $inc: { tokenVersion: 1 } }
  );
  await audit.recordSafe({ actorId: user._id, action: 'PASSWORD_RESET' });
}

// Admin-issued reset: the Admin is shown the link once and passes it on. (Until e-mail exists.)
async function issueResetLinkForUser(actor, userId, slug) {
  const user = await User.findOne({ _id: userId, isActive: true });
  if (!user) throw new AppError(404, 'User not found');
  const url = await issueResetToken(user, slug);
  await audit.recordSafe({ actorId: actor._id, action: 'PASSWORD_RESET_ISSUED', details: { userId: String(user._id) } });
  await sendQuietly({ to: user.email, template: 'password-reset', data: { link: url, name: user.name } }, { userId: user._id });
  return url;
}

// ---- e-mail verification -----------------------------------------------------------------
async function sendVerification(user, slug) {
  if (user.emailVerifiedAt) return null;
  await AuthToken.updateMany({ userId: user._id, type: 'VERIFY_EMAIL', usedAt: null }, { $set: { usedAt: new Date() } });
  const token = newToken();
  await AuthToken.create({ userId: user._id, type: 'VERIFY_EMAIL', tokenHash: hashToken(token), expiresAt: inFuture(SECURITY.VERIFY_TTL_MS) });
  const url = link(slug, 'verify-email.html', token);
  await sendQuietly({ to: user.email, template: 'verify-email', data: { link: url, name: user.name } }, { userId: user._id });
  return url;
}

async function verifyEmail(token) {
  if (!looksLikeToken(token)) throw new AppError(400, INVALID_LINK);
  const used = await AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(token), type: 'VERIFY_EMAIL', usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } }
  );
  if (!used) throw new AppError(400, INVALID_LINK);
  const user = await User.findOneAndUpdate({ _id: used.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
  if (user) await audit.recordSafe({ actorId: user._id, action: 'EMAIL_VERIFIED' });
}

// ---- staff invitations -------------------------------------------------------------------
async function createInvite(actor, { email, role, department, name }, slug) {
  if (!STAFF_ROLES.includes(role)) throw new AppError(400, 'Invalid staff role');
  if (DEPARTMENT_ROLES.includes(role)) {
    if (!(await configService.isActiveDepartment(department))) throw new AppError(400, 'Choose one of this institution\'s departments');
  } else {
    department = null; // Principal: institution-wide
  }
  if (await User.exists({ email })) throw new AppError(409, 'A user with this email address already exists');

  const token = newToken();
  const invite = await runInTransaction(async (session) => {
    const opt = session ? { session } : {};
    // One live invitation per address: a new one replaces any earlier pending one.
    await Invite.updateMany({ email, usedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } }, opt);
    const [created] = await Invite.create(
      [{ email, name: name || null, role, department, tokenHash: hashToken(token), expiresAt: inFuture(SECURITY.INVITE_TTL_MS), createdBy: actor._id }],
      opt
    );
    await audit.record({ actorId: actor._id, action: 'INVITE_CREATED', details: { inviteId: String(created._id), role, department } }, { session });
    return created;
  });
  const url = link(slug, 'accept-invite.html', token);
  await sendQuietly({ to: email, template: 'staff-invite', data: { link: url, role, name: name || null } });
  return { invite, link: url };
}

const listInvites = () => Invite.find({}).sort({ createdAt: -1 }).limit(200);

async function revokeInvite(actor, id) {
  const res = await Invite.updateOne({ _id: id, usedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (res.matchedCount === 0) throw new AppError(404, 'No open invitation with that id');
  await audit.recordSafe({ actorId: actor._id, action: 'INVITE_REVOKED', details: { inviteId: String(id) } });
}

// A new token and a fresh expiry; the old link stops working.
async function resendInvite(actor, id, slug) {
  const token = newToken();
  const invite = await Invite.findOneAndUpdate(
    { _id: id, usedAt: null, revokedAt: null },
    { $set: { tokenHash: hashToken(token), expiresAt: inFuture(SECURITY.INVITE_TTL_MS) } },
    { returnDocument: 'after' }
  );
  if (!invite) throw new AppError(404, 'No open invitation with that id');
  await audit.recordSafe({ actorId: actor._id, action: 'INVITE_RESENT', details: { inviteId: String(id) } });
  const url = link(slug, 'accept-invite.html', token);
  await sendQuietly({ to: invite.email, template: 'staff-invite', data: { link: url, role: invite.role, name: invite.name } });
  return { invite, link: url };
}

// What the invitation page shows before the person chooses a password.
async function peekInvite(token) {
  if (!looksLikeToken(token)) throw new AppError(400, INVALID_LINK);
  const invite = await Invite.findOne({ tokenHash: hashToken(token), usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!invite) throw new AppError(400, INVALID_LINK);
  return { email: invite.email, role: invite.role, department: invite.department, name: invite.name };
}

// Accepting creates the account with the invitee's own password. The invite is consumed and the
// user created in one transaction (where available), so a failure leaves the invite usable.
async function acceptInvite(token, { name, password }) {
  if (!looksLikeToken(token)) throw new AppError(400, INVALID_LINK);
  const passwordHash = await authService.hashPassword(password);
  return runInTransaction(async (session) => {
    const opt = session ? { session } : {};
    const invite = await Invite.findOneAndUpdate(
      { tokenHash: hashToken(token), usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after', ...opt }
    );
    if (!invite) throw new AppError(400, INVALID_LINK);
    if (DEPARTMENT_ROLES.includes(invite.role) && !(await configService.isActiveDepartment(invite.department))) {
      throw new AppError(400, 'This invitation is no longer valid. Ask your administrator for a new one.');
    }
    const [user] = await User.create(
      [{
        name, email: invite.email, passwordHash, role: invite.role, department: invite.department,
        emailVerifiedAt: new Date(), // the invitation reached this address
      }],
      opt
    );
    await audit.record({ actorId: user._id, action: 'INVITE_ACCEPTED', details: { inviteId: String(invite._id), role: invite.role } }, { session });
    return user;
  });
}

// ---- admin account tools -----------------------------------------------------------------
async function unlock(actor, id) {
  const res = await User.updateOne({ _id: id }, { $set: { failedLogins: 0, lockedUntil: null } });
  if (res.matchedCount === 0) throw new AppError(404, 'User not found');
  await audit.recordSafe({ actorId: actor._id, action: 'ACCOUNT_UNLOCKED', details: { userId: String(id) } });
}

async function signOutEverywhere(actor, id) {
  const res = await revokeSessions(id);
  if (res.matchedCount === 0) throw new AppError(404, 'User not found');
  await audit.recordSafe({ actorId: actor._id, action: 'SESSIONS_REVOKED', details: { userId: String(id) } });
}

async function markVerified(actor, id) {
  const user = await User.findOneAndUpdate({ _id: id }, { $set: { emailVerifiedAt: new Date() } });
  if (!user) throw new AppError(404, 'User not found');
  await audit.recordSafe({ actorId: actor._id, action: 'EMAIL_VERIFIED', details: { userId: String(id), by: 'admin' } });
}

module.exports = {
  revokeSessions, changePassword, requestReset, resetPassword, issueResetLinkForUser,
  sendVerification, verifyEmail, createInvite, listInvites, revokeInvite, resendInvite,
  peekInvite, acceptInvite, unlock, signOutEverywhere, markVerified,
};
