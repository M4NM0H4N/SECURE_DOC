'use strict';

// Housekeeping for the document store (S4). Dry run unless --apply.
//   npm run storage:cleanup                       report only
//   npm run storage:cleanup -- --apply            delete
//   options: --grace-hours=24   --retention-days=30
//
// It deletes only two kinds of file:
//   1. ORPHANS: stored files that no Document record (and no legacy request.documentPath)
//      points to, and that are older than the grace period (so an upload that is still being
//      saved is never touched).
//   2. EXPIRED VERSIONS: files of REPLACED or REVOKED documents, once the retention period
//      (DOCUMENT_RETENTION_DAYS, default 30) has passed. The Document record stays, marked purged.
// ACTIVE documents are never deleted. It also REPORTS (does not fix) active documents whose
// file is missing. Output is counts only: no keys, names or connection strings.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const config = require('../server/config/env');
const Document = require('../server/models/Document');
const Request = require('../server/models/Request');
const { getStorage } = require('../server/storage');

const DAY = 24 * 60 * 60 * 1000;

async function cleanup({ apply = false, graceHours = 24, retentionDays = config.retentionDays, now = new Date(), storage = getStorage() } = {}) {
  const report = { applied: apply, storedFiles: 0, orphans: 0, expiredVersions: 0, activeMissingFiles: 0, deleted: 0 };

  const files = await storage.list();
  report.storedFiles = files.length;
  const present = new Set(files.map((f) => f.key));

  // Native reads: this is a platform job that spans every institution.
  const docs = await Document.collection.find({}, { projection: { key: 1, status: 1, replacedAt: 1, revokedAt: 1, purgedAt: 1 } }).toArray();
  const referenced = new Set(docs.map((d) => d.key));
  const legacy = await Request.collection.find({ documentPath: { $type: 'string' } }, { projection: { documentPath: 1 } }).toArray();
  for (const r of legacy) referenced.add(r.documentPath);

  const graceCutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);
  const orphans = files.filter((f) => !referenced.has(f.key) && f.modifiedAt < graceCutoff);
  report.orphans = orphans.length;

  const retentionCutoff = new Date(now.getTime() - retentionDays * DAY);
  const expired = docs.filter((d) => {
    if (!['REPLACED', 'REVOKED'].includes(d.status) || d.purgedAt) return false;
    const since = d.status === 'REPLACED' ? d.replacedAt : d.revokedAt;
    return since && since < retentionCutoff && present.has(d.key);
  });
  report.expiredVersions = expired.length;
  report.activeMissingFiles = docs.filter((d) => d.status === 'ACTIVE' && !present.has(d.key)).length;

  if (apply) {
    for (const f of orphans) {
      await storage.deleteRaw(f.key);
      report.deleted += 1;
    }
    for (const d of expired) {
      await storage.deleteRaw(d.key);
      await Document.collection.updateOne({ _id: d._id }, { $set: { purgedAt: now } });
      report.deleted += 1;
    }
  }
  return report;
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

if (require.main === module) {
  (async () => {
    if (!config.mongoUri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(config.mongoUri);
    try {
      const report = await cleanup({
        apply: process.argv.includes('--apply'),
        graceHours: arg('grace-hours') ? Number(arg('grace-hours')) : undefined,
        retentionDays: arg('retention-days') ? Number(arg('retention-days')) : undefined,
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.applied) console.log('Dry run only. Nothing was deleted. Re-run with --apply to delete.');
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error('Cleanup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { cleanup };
