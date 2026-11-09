'use strict';

const User = require('../models/User');
const { SECURITY } = require('../config/constants');
const audit = require('./auditService');

const isLocked = (user) => Boolean(user.lockedUntil && user.lockedUntil > new Date());

// Counts a failed password or MFA attempt. The increment is atomic; reaching the limit locks
// the account for a fixed time and resets the counter. Callers answer with the SAME generic
// error whether the account is wrong, unknown or locked, so this is invisible to an attacker.
async function registerFailure(user) {
  const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { returnDocument: 'after' });
  if (updated && updated.failedLogins >= SECURITY.MAX_FAILED_LOGINS) {
    const locked = await User.updateOne(
      { _id: user._id, failedLogins: { $gte: SECURITY.MAX_FAILED_LOGINS } },
      { $set: { lockedUntil: new Date(Date.now() + SECURITY.LOCKOUT_MS), failedLogins: 0 } }
    );
    if (locked.modifiedCount === 1) await audit.recordSafe({ actorId: user._id, action: 'ACCOUNT_LOCKED' });
  }
}

async function clearFailures(user) {
  if (user.failedLogins || user.lockedUntil) {
    await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null } });
  }
}

module.exports = { isLocked, registerFailure, clearFailures };
