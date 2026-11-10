'use strict';

// Data portability and deletion for one institution.
//  * exportInstitution: the institution's own Admin downloads everything the institution holds, as JSON.
//    Credentials are never in it: fields the models mark select:false (password and MFA material, token and
//    key hashes, storage keys) are not selected, and one-time tokens are left out entirely.
//  * suspend / resume / deleteInstitution: SUPER_ADMIN only. Deletion needs the institution to be
//    suspended first and the slug typed back, removes stored files before database rows (so a failure leaves
//    the data intact and retryable), and leaves a platform audit entry that survives the deletion.
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const AppError = require('../utils/AppError');
const { runAsTenant, runUnscoped } = require('../utils/tenantContext');
const { getStorage } = require('../storage');
const audit = require('./auditService');
const { logger } = require('../utils/logger');

const MAX_ROWS = 20000;
const SKIP_IN_EXPORT = new Set(['AuthToken']); // one-time tokens: nothing to port, only risk

// Every model that carries a tenantId. Found dynamically so a model added later cannot be forgotten.
function tenantModels() {
  return mongoose.modelNames()
    .map((n) => mongoose.model(n))
    .filter((m) => m.schema.path('tenantId'));
}

async function exportInstitution(user) {
  const bundle = { exportedAt: new Date().toISOString(), format: 1, collections: {} };
  for (const model of tenantModels()) {
    if (SKIP_IN_EXPORT.has(model.modelName)) continue;
    const count = await model.countDocuments({});
    if (count > MAX_ROWS) throw new AppError(413, `Too many ${model.collection.name} to export in one file (${count}). Ask the platform operator for a full database export.`);
    const rows = await model.find({}).lean();
    bundle.collections[model.collection.name] = rows.map(({ __v, ...r }) => r);
  }
  const tenant = await runUnscoped(() => Tenant.findOne({ _id: user.tenantId }).lean());
  if (tenant) bundle.institution = { name: tenant.name, slug: tenant.slug, createdAt: tenant.createdAt };
  await audit.record({ actorId: user._id, action: 'DATA_EXPORTED', details: { kind: 'institution', documents: Object.values(bundle.collections).reduce((n, c) => n + c.length, 0) } });
  return bundle;
}

async function setStatus(slug, from, to, action, actor) {
  const tenant = await runUnscoped(() => Tenant.findOneAndUpdate({ slug, status: from }, { $set: { status: to } }, { returnDocument: 'after' }));
  if (!tenant) {
    const exists = await runUnscoped(() => Tenant.exists({ slug }));
    throw new AppError(exists ? 409 : 404, exists ? `The institution is not ${from.toLowerCase()}` : 'Institution not found');
  }
  await runUnscoped(() => audit.record({ actorId: actor._id, action, details: { slug } }));
  return tenant;
}

const suspend = (slug, actor) => setStatus(slug, 'ACTIVE', 'SUSPENDED', 'TENANT_SUSPENDED', actor);
const resume = (slug, actor) => setStatus(slug, 'SUSPENDED', 'ACTIVE', 'TENANT_RESUMED', actor);

async function deleteInstitution(slug, confirm, actor) {
  if (confirm !== slug) throw new AppError(400, 'Type the institution address exactly to confirm deletion');
  const tenant = await runUnscoped(() => Tenant.findOne({ slug }));
  if (!tenant) throw new AppError(404, 'Institution not found');
  if (tenant.status !== 'SUSPENDED') throw new AppError(409, 'Suspend the institution first; deletion is only allowed for a suspended institution');

  // 1. Stored files. A failure stops here, before any database row is touched.
  const storage = getStorage();
  const prefix = `${tenant._id}/`;
  let files = 0;
  for (const f of await storage.list()) {
    if (!f.key.startsWith(prefix)) continue;
    if (typeof storage.deleteRaw === 'function') await storage.deleteRaw(f.key);
    else await storage.delete(f.key);
    files += 1;
  }

  // 2. Database rows, every model that has a tenantId (native calls: the audit model refuses deletes on purpose).
  const removed = {};
  for (const model of tenantModels()) {
    const r = await model.collection.deleteMany({ tenantId: tenant._id });
    removed[model.collection.name] = r.deletedCount;
  }
  await Tenant.collection.deleteOne({ _id: tenant._id });

  // 3. The record of the deletion lives on the platform's own chain and is not deleted with the institution.
  const rows = Object.values(removed).reduce((n, c) => n + c, 0);
  await runUnscoped(() => audit.record({ actorId: actor._id, action: 'TENANT_DELETED', details: { slug, rows, files } }));
  logger.info('institution deleted', { rows, files });
  return { slug, rows, files, collections: removed };
}

module.exports = { exportInstitution, suspend, resume, deleteInstitution, tenantModels, runAsTenant };
