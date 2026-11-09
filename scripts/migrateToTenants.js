'use strict';

// One-off, idempotent migration from the single-tenant MVP data to tenants (S1) and to
// configurable institutions (S2).
//   npm run migrate:tenants                       dry run: only counts what WOULD change
//   npm run migrate:tenants -- --apply            write the changes
//   options: --slug=<address> (default "default")  --name="Institution name"
//
// What it does: creates (or reuses) one institution, back-fills tenantId on every legacy
// user, request and audit record that has none, then replaces the old global-unique email
// index with the per-tenant one. SUPER_ADMIN users are never assigned to a tenant.
// S2 part, for EVERY institution: seeds the default departments, document types and the
// Clerk -> HOD workflow if the institution has none, and pins every request that has no
// workflow yet to that definition (PENDING = step 0, any other status = the last step).
// It uses native collection calls on purpose (the plugin refuses unscoped writes).
// Run it on a COPY of the data first. It prints counts only, never connection strings.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Tenant = require('../server/models/Tenant');
const User = require('../server/models/User');
const Request = require('../server/models/Request');
const AuditLog = require('../server/models/AuditLog');
const { runUnscoped, runAsTenant } = require('../server/utils/tenantContext');
const WorkflowDefinition = require('../server/models/WorkflowDefinition');
const { seedDefaults } = require('../server/services/institutionService');

const LEGACY = { tenantId: { $exists: false } };
const NO_WORKFLOW = { workflowDefinitionId: { $exists: false } };

async function migrate({ slug = 'default', name = 'Default Institution', apply = false } = {}) {
  const report = { applied: apply, tenant: slug, users: 0, requests: 0, auditLogs: 0, droppedEmailIndex: false, createdTenant: false, requestsToPin: 0, tenantsToSeed: 0 };

  let tenant = await runUnscoped(() => Tenant.findOne({ slug }));
  const userFilter = { ...LEGACY, role: { $ne: 'SUPER_ADMIN' } };
  report.users = await User.collection.countDocuments(userFilter);
  report.requests = await Request.collection.countDocuments(LEGACY);
  report.auditLogs = await AuditLog.collection.countDocuments(LEGACY);
  const indexes = await User.collection.indexes().catch(() => []);
  const oldEmailIndex = indexes.find((i) => i.name === 'email_1');
  report.droppedEmailIndex = Boolean(oldEmailIndex);
  report.createdTenant = !tenant;
  report.requestsToPin = await Request.collection.countDocuments(NO_WORKFLOW);
  const existing = await runUnscoped(() => Tenant.find({}));
  for (const t of existing) {
    if (!(await WorkflowDefinition.collection.countDocuments({ tenantId: t._id }))) report.tenantsToSeed += 1;
  }

  if (!apply) {
    if (!tenant) report.tenantsToSeed += 1; // the institution this run would create
    return report;
  }

  if (!tenant) tenant = await runUnscoped(() => Tenant.create({ slug, name }));
  const set = { $set: { tenantId: tenant._id } };
  await User.collection.updateMany(userFilter, set);
  await Request.collection.updateMany(LEGACY, set);
  await AuditLog.collection.updateMany(LEGACY, set);
  if (oldEmailIndex) await User.collection.dropIndex('email_1');
  await Promise.all([Tenant.createIndexes(), User.createIndexes(), Request.createIndexes(), AuditLog.createIndexes()]);

  // S2: configuration and workflow pinning for every institution.
  for (const t of await runUnscoped(() => Tenant.find({}))) {
    await runAsTenant(t._id, async () => {
      await seedDefaults();
      const def = await WorkflowDefinition.findOne({}).sort({ version: -1 });
      const last = def.steps.length - 1;
      const own = { tenantId: t._id, ...NO_WORKFLOW };
      await Request.collection.updateMany({ ...own, status: { $in: ['PENDING', 'NEEDS_INFO'] } }, { $set: { workflowDefinitionId: def._id, currentStepIndex: 0 } });
      await Request.collection.updateMany(own, { $set: { workflowDefinitionId: def._id, currentStepIndex: last } });
    });
  }
  await Promise.all([
    require('../server/models/Department').createIndexes(),
    require('../server/models/DocumentType').createIndexes(),
    WorkflowDefinition.createIndexes(),
  ]);
  return report;
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    try {
      const report = await migrate({ slug: arg('slug'), name: arg('name'), apply: process.argv.includes('--apply') });
      console.log(JSON.stringify(report, null, 2));
      if (!report.applied) console.log('Dry run only. Nothing was changed. Re-run with --apply to write.');
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate };
