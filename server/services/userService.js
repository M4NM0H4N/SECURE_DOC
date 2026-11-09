'use strict';

const User = require('../models/User');
const { DEPARTMENT_ROLES } = require('../config/constants');
const { hashPassword } = require('./authService');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');

async function createStaff(actor, { name, email, password, role, department }) {
  if (!DEPARTMENT_ROLES.includes(role)) department = null; // Principal: institution-wide
  const passwordHash = await hashPassword(password);
  return runInTransaction(async (session) => {
    const [user] = await User.create([{ name, email, passwordHash, role, department }], session ? { session } : {});
    await audit.record(
      { actorId: actor._id, action: 'USER_CREATED_BY_ADMIN', details: { userId: String(user._id), role, department } },
      { session }
    );
    return user;
  });
}

async function listUsers({ role, page = 1, limit = 50 }) {
  const filter = {};
  if (role) filter.role = role;
  const [items, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

// Whitelisted fields only (prevents mass assignment). Role is never updatable.
async function updateUser(actor, id, changes) {
  if (String(actor._id) === String(id) && changes.isActive === false) {
    throw new AppError(400, 'You cannot deactivate your own account');
  }
  return runInTransaction(async (session) => {
    const query = User.findById(id);
    const user = await (session ? query.session(session) : query);
    if (!user) throw new AppError(404, 'User not found');

    const wasActive = user.isActive;
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.isActive !== undefined) user.isActive = changes.isActive;
    if (changes.department !== undefined) {
      if (!DEPARTMENT_ROLES.includes(user.role)) throw new AppError(400, 'This role has no department');
      user.department = changes.department;
    }
    await user.save(session ? { session } : {});

    if (changes.isActive !== undefined && changes.isActive !== wasActive) {
      await audit.record(
        {
          actorId: actor._id,
          action: changes.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
          details: { userId: String(user._id) },
        },
        { session }
      );
    }
    return user;
  });
}

module.exports = { createStaff, listUsers, updateUser };
