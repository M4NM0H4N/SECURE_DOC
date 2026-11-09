'use strict';

const WorkflowDefinition = require('../models/WorkflowDefinition');
const User = require('../models/User');
const { normaliseSteps } = require('./workflowEngine');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');
const AppError = require('../utils/AppError');

const withSession = (query, session) => (session ? query.session(session) : query);

// The institution's current definition = its highest version.
function getCurrent(session) {
  return withSession(WorkflowDefinition.findOne({}).sort({ version: -1 }), session);
}

function getById(id, session) {
  return withSession(WorkflowDefinition.findOne({ _id: id }), session);
}

// Definitions for a batch of requests, keyed by id (one query, tenant-scoped).
async function getMap(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const defs = unique.length ? await WorkflowDefinition.find({ _id: { $in: unique } }) : [];
  return new Map(defs.map((d) => [String(d._id), d]));
}

// Editing the chain never changes an existing definition: it creates the next version, and
// only requests submitted afterwards use it. Requests in progress keep the version they began with.
async function createVersion(actor, input) {
  const steps = normaliseSteps(input);
  return runInTransaction(async (session) => {
    const current = await getCurrent(session);
    const version = current ? current.version + 1 : 1;
    const [created] = await WorkflowDefinition.create([{ version, steps, createdBy: actor._id }], session ? { session } : {});
    await audit.record(
      {
        actorId: actor._id,
        action: 'WORKFLOW_UPDATED',
        details: { version, steps: steps.map((s) => ({ label: s.label, role: s.role, canReject: s.canReject })) },
      },
      { session }
    );
    return created;
  });
}

// Roles used by a chain that currently have no active staff member, so the Admin is not
// surprised by a request that nobody can act on. A warning, not an error.
async function rolesWithoutStaff(steps) {
  const roles = [...new Set([...steps.map((s) => s.role), 'CLERK'])];
  const active = await User.distinct('role', { role: { $in: roles }, isActive: true });
  return roles.filter((r) => !active.includes(r));
}

async function requireCurrent(session) {
  const current = await getCurrent(session);
  if (!current) throw new AppError(409, 'This institution has no approval workflow configured');
  return current;
}

module.exports = { getCurrent, getById, getMap, createVersion, rolesWithoutStaff, requireCurrent };
