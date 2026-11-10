'use strict';

const User = require('../models/User');
const { contains, sortSpec, dateRange } = require('../utils/listQuery');
const { MAX_EXPORT_ROWS } = require('../utils/csv');
const { DEPARTMENT_ROLES } = require('../config/constants');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');

const USER_SORTS = ['createdAt', 'name', 'email', 'role'];

function userFilter({ role, active, department, q, from, to }) {
  const filter = {};
  if (role) filter.role = role;
  if (active !== undefined) filter.isActive = active;
  if (department) filter.department = department;
  Object.assign(filter, dateRange('createdAt', from, to));
  if (q) {
    const rx = contains(q);
    filter.$or = [{ name: rx }, { email: rx }];
  }
  return filter;
}

async function listUsers(params) {
  const { page = 1, limit = 50, sort, order } = params;
  const filter = userFilter(params);
  const [items, total] = await Promise.all([
    User.find(filter)
      .sort(sortSpec({ sort, order, defaultSort: 'createdAt' }))
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

async function exportUsers(params) {
  const found = await User.find(userFilter(params)).sort(sortSpec({ sort: params.sort, order: params.order, defaultSort: 'createdAt' })).limit(MAX_EXPORT_ROWS + 1);
  const header = ['id', 'name', 'email', 'role', 'department', 'active', 'e-mail verified', 'two-step', 'created'];
  const rows = found.slice(0, MAX_EXPORT_ROWS).map((x) => [String(x._id), x.name, x.email, x.role, x.department || '', x.isActive, Boolean(x.emailVerifiedAt), Boolean(x.mfaEnabled), x.createdAt]);
  return { header, rows, truncated: found.length > MAX_EXPORT_ROWS };
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
    // Deactivation ends every session right away (a bumped version, not just the per-request check).
    if (changes.isActive === false && wasActive) user.tokenVersion = (user.tokenVersion || 0) + 1;
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

module.exports = { listUsers, exportUsers, updateUser, USER_SORTS };
