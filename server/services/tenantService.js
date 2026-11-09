'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const { runAsTenant, runUnscoped } = require('../utils/tenantContext');
const { hashPassword } = require('./authService');
const audit = require('./auditService');
const { seedDefaults } = require('./institutionService');

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();

// Constant-time comparison; false when signup is closed (no key configured).
function signupKeyMatches(supplied) {
  if (!config.signupKey) return false;
  return crypto.timingSafeEqual(digest(supplied), digest(config.signupKey));
}

// Creates an institution and its first Admin in one transaction (where supported).
async function signup({ institutionName, slug, adminName, adminEmail, adminPassword, signupKey }) {
  if (!config.signupKey) throw new AppError(403, 'Institution signup is closed');
  if (!signupKeyMatches(signupKey)) throw new AppError(403, 'Invalid signup key');

  const passwordHash = await hashPassword(adminPassword);
  return runInTransaction(async (session) => {
    const opt = session ? { session } : {};
    const [tenant] = await runUnscoped(() => Tenant.create([{ name: institutionName, slug }], opt));
    const admin = await runAsTenant(tenant._id, async () => {
      await seedDefaults({ session });
      const [user] = await User.create(
        [{ name: adminName, email: adminEmail, passwordHash, role: ROLES.ADMIN, department: null }],
        opt
      );
      await audit.record(
        { actorId: user._id, action: 'TENANT_CREATED', details: { tenantId: String(tenant._id), slug } },
        { session }
      );
      return user;
    });
    return { tenant, admin };
  });
}

// Platform view: names and status only, never any tenant's requests or documents.
function listTenants() {
  return runUnscoped(() => Tenant.find({}).sort({ createdAt: -1 }).limit(200));
}

module.exports = { signup, listTenants, signupKeyMatches };
