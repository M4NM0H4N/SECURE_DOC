'use strict';

const crypto = require('crypto');
const totp = require('../utils/totp');
const config = require('../config/env');
const User = require('../models/User');
const { SECURITY } = require('../config/constants');
const AppError = require('../utils/AppError');
const authService = require('./authService');
const audit = require('./auditService');
const { hashToken } = require('../utils/tokens');

const ISSUER = 'DocFlow';
const BACKUP_FORMAT = /^[0-9a-f]{5}-?[0-9a-f]{5}$/;
const withSecrets = (query) => query.select('+mfaSecret +mfaBackupCodes +mfaLastStep');

const available = () => Boolean(config.mfaKey);

// AES-256-GCM with a key derived from MFA_ENCRYPTION_KEY. Format: iv.tag.ciphertext (base64url).
function key() {
  return crypto.createHash('sha256').update(`docflow-mfa:${config.mfaKey}`).digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  const [iv, tag, body] = String(blob).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function assertAllowed(user) {
  if (!available()) throw new AppError(503, 'Multi-factor authentication is not available on this server');
  if (!SECURITY.MFA_ROLES.includes(user.role)) throw new AppError(403, 'Multi-factor authentication is for staff accounts');
}

// Step 1: create a secret (stored encrypted, not yet active) and return it ONCE for the app.
async function beginSetup(user) {
  assertAllowed(user);
  if (user.mfaEnabled) throw new AppError(409, 'Multi-factor authentication is already enabled');
  const secret = totp.generateSecret();
  await User.updateOne({ _id: user._id }, { $set: { mfaSecret: encrypt(secret), mfaLastStep: null } });
  return { secret, otpauthUrl: totp.otpauthUrl({ issuer: ISSUER, label: user.email, secret }) };
}

// A TOTP code is accepted once: the time step must be newer than the last accepted one.
async function checkTotp(userId, secret, code) {
  const result = totp.verify(secret, code);
  if (!result.valid) return false;
  const claimed = await User.updateOne(
    { _id: userId, $or: [{ mfaLastStep: null }, { mfaLastStep: { $lt: result.timeStep } }] },
    { $set: { mfaLastStep: result.timeStep } }
  );
  return claimed.modifiedCount === 1;
}

// Backup codes are single use: the unused entry is flagged in one atomic update.
async function checkBackup(userId, code) {
  const hash = hashToken(code.replace('-', ''));
  const used = await User.updateOne(
    { _id: userId, mfaBackupCodes: { $elemMatch: { hash, usedAt: null } } },
    { $set: { 'mfaBackupCodes.$.usedAt': new Date() } }
  );
  return used.modifiedCount === 1;
}

// Accepts an authenticator code or a backup code. Returns true/false, never throws on a bad code.
async function verifyCode(userId, rawCode) {
  // Fails closed: without the server key no secret can be read, so no code can be right.
  if (typeof rawCode !== 'string' || !available()) return false;
  const code = rawCode.replace(/\s+/g, '').toLowerCase();
  const user = await withSecrets(User.findById(userId));
  if (!user || !user.mfaSecret) return false;
  if (BACKUP_FORMAT.test(code)) return user.mfaEnabled ? checkBackup(userId, code) : false;
  if (!/^\d{6}$/.test(code)) return false;
  let secret;
  try {
    secret = decrypt(user.mfaSecret);
  } catch (_err) {
    return false; // wrong key or damaged value
  }
  return checkTotp(userId, secret, code);
}

function newBackupCodes() {
  return Array.from({ length: SECURITY.BACKUP_CODES }, () => {
    const raw = crypto.randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// Step 2: prove the app works by entering a code; then MFA is on and the backup codes are shown once.
async function enable(user, code) {
  assertAllowed(user);
  const fresh = await withSecrets(User.findById(user._id));
  if (fresh.mfaEnabled) throw new AppError(409, 'Multi-factor authentication is already enabled');
  if (!fresh.mfaSecret) throw new AppError(409, 'Start the setup first');
  if (!(await verifyCode(user._id, code))) throw new AppError(400, 'That code is not valid. Check your authenticator app and try again.');
  const codes = newBackupCodes();
  await User.updateOne(
    { _id: user._id },
    { $set: { mfaEnabled: true, mfaBackupCodes: codes.map((c) => ({ hash: hashToken(c.replace('-', '')), usedAt: null })) } }
  );
  await audit.recordSafe({ actorId: user._id, action: 'MFA_ENABLED' });
  return codes;
}

// Turning it off needs the password AND a current code, and ends every session.
async function disable(user, password, code) {
  const full = await User.findById(user._id).select('+passwordHash');
  if (!full.mfaEnabled) throw new AppError(409, 'Multi-factor authentication is not enabled');
  if (!(await authService.verifyPassword(password, full.passwordHash)) || !(await verifyCode(user._id, code))) {
    throw new AppError(400, 'Password or code is not valid');
  }
  await User.updateOne(
    { _id: user._id },
    { $set: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [], mfaLastStep: null }, $inc: { tokenVersion: 1 } }
  );
  await audit.recordSafe({ actorId: user._id, action: 'MFA_DISABLED' });
}

module.exports = { available, beginSetup, enable, disable, verifyCode, encrypt, decrypt };
