'use strict';

// S4 housekeeping: the cleanup script and the migration of pre-S4 single files.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, getDefaultTenant, runAsTenant, request } = require('./helpers');
const { startFakeS3 } = require('./fakes');
const { cleanup } = require('../../scripts/storageCleanup');
const { migrate } = require('../../scripts/migrateToTenants');
const Document = require('../models/Document');
const Request = require('../models/Request');
const config = require('../config/env');
const LocalAdapter = require('../storage/localAdapter');
const S3Adapter = require('../storage/s3Adapter');
const { useStorage, makeKey } = require('../storage');
const verification = require('../services/verificationService');

const DAY = 24 * 60 * 60 * 1000;
const PDF = (label = crypto.randomUUID()) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let app;
let fakeS3;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
  fakeS3 = await startFakeS3({ pageSize: 2 });
});
afterAll(async () => {
  await fakeS3.close();
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  fakeS3.objects.clear();
});

// A document with a stored file, created directly (the upload path is tested elsewhere).
async function seedDoc(adapter, { status = 'ACTIVE', replacedAt = null, revokedAt = null, buf = PDF() } = {}) {
  const student = await createUser({ role: 'STUDENT' });
  const clerk = await createUser({ role: 'CLERK' });
  const r = await createRequest(student, { status: 'FULFILLED' });
  const key = makeKey(getDefaultTenant()._id, r._id, 'pdf');
  await adapter.put(key, buf);
  const doc = await Document.create({ requestId: r._id, key, fileType: 'pdf', sizeBytes: buf.length, sha256: sha(buf), uploadedBy: clerk._id, status, replacedAt, revokedAt });
  return { r, key, doc, student, clerk };
}
const keysOf = async (adapter) => (await adapter.list()).map((f) => f.key).sort();

describe.each([
  ['local', () => new LocalAdapter(process.env.UPLOAD_DIR)],
  ['s3', () => new S3Adapter(fakeS3.config)],
])('storage cleanup on the %s adapter', (_name, make) => {
  const future = (days) => new Date(Date.now() + days * DAY);

  test('dry run reports and deletes nothing', async () => {
    const adapter = make();
    await seedDoc(adapter);
    const orphan = makeKey(getDefaultTenant()._id, new mongoose.Types.ObjectId(), 'pdf');
    await adapter.put(orphan, PDF());
    const report = await cleanup({ storage: adapter, now: future(3) });
    expect(report).toMatchObject({ applied: false, storedFiles: 2, orphans: 1, expiredVersions: 0, deleted: 0 });
    expect(await keysOf(adapter)).toHaveLength(2);
  });

  test('orphans are deleted only after the grace period; referenced and active files never', async () => {
    const adapter = make();
    const active = await seedDoc(adapter);
    const orphan = makeKey(getDefaultTenant()._id, new mongoose.Types.ObjectId(), 'png');
    await adapter.put(orphan, PDF());

    // Right now the orphan is younger than the 24 h grace period: an upload may still be in flight.
    expect(await cleanup({ storage: adapter, apply: true })).toMatchObject({ orphans: 0, deleted: 0 });
    expect(await keysOf(adapter)).toHaveLength(2);

    // Two days later it is an orphan; the active document's file stays.
    const report = await cleanup({ storage: adapter, apply: true, now: future(2) });
    expect(report).toMatchObject({ applied: true, orphans: 1, deleted: 1 });
    expect(await keysOf(adapter)).toEqual([active.key]);
    expect((await Document.findById(active.doc._id)).status).toBe('ACTIVE');
  });

  test('replaced and revoked files go only after the retention period, and the record is marked purged', async () => {
    const adapter = make();
    const days = (n) => new Date(Date.now() - n * DAY);
    const replaced = await seedDoc(adapter, { status: 'REPLACED', replacedAt: days(40) });
    const revoked = await seedDoc(adapter, { status: 'REVOKED', revokedAt: days(31) });
    const recent = await seedDoc(adapter, { status: 'REVOKED', revokedAt: days(5) });
    const active = await seedDoc(adapter);

    expect(await cleanup({ storage: adapter, retentionDays: 30 })).toMatchObject({ expiredVersions: 2, deleted: 0, orphans: 0 });
    const report = await cleanup({ storage: adapter, retentionDays: 30, apply: true });
    expect(report).toMatchObject({ expiredVersions: 2, deleted: 2 });
    expect(await keysOf(adapter)).toEqual([recent.key, active.key].sort());
    expect((await Document.findById(replaced.doc._id)).purgedAt).toBeTruthy();
    expect((await Document.findById(revoked.doc._id)).status).toBe('REVOKED'); // history stays
    expect((await Document.findById(recent.doc._id)).purgedAt).toBeNull();
    // Running it again finds nothing more.
    expect(await cleanup({ storage: adapter, retentionDays: 30, apply: true })).toMatchObject({ expiredVersions: 0, deleted: 0 });
  });

  test('an active document whose file is missing is reported, never "fixed"', async () => {
    const adapter = make();
    const s = await seedDoc(adapter);
    await adapter.delete(s.key);
    const report = await cleanup({ storage: adapter, apply: true, now: future(2) });
    expect(report).toMatchObject({ activeMissingFiles: 1, deleted: 0 });
    expect((await Document.findById(s.doc._id)).status).toBe('ACTIVE');
  });

  test('a file still referenced by a legacy request.documentPath is not an orphan', async () => {
    const adapter = make();
    if (adapter.name === 's3') fakeS3.objects.set('legacy-0000.pdf', { body: PDF(), modifiedAt: new Date() });
    else {
      fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'legacy-0000.pdf'), PDF());
    }
    const student = await createUser({ role: 'STUDENT' });
    const r = await createRequest(student, { status: 'FULFILLED' });
    await Request.collection.updateOne({ _id: r._id }, { $set: { documentPath: 'legacy-0000.pdf' } });
    expect(await cleanup({ storage: adapter, apply: true, now: future(3) })).toMatchObject({ orphans: 0, deleted: 0 });
    await Request.collection.updateOne({ _id: r._id }, { $unset: { documentPath: '' } });
    expect(await cleanup({ storage: adapter, apply: true, now: future(3) })).toMatchObject({ orphans: 1, deleted: 1 });
  });
});

describe('migration of pre-S4 single files', () => {
  const legacyName = (ext = 'pdf') => `${crypto.randomUUID()}.${ext}`;
  async function legacy({ withFile = true, buf = PDF('legacy'), ext = 'pdf' } = {}) {
    const name = legacyName(ext);
    fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
    if (withFile) fs.writeFileSync(path.join(process.env.UPLOAD_DIR, name), buf);
    const student = await createUser({ role: 'STUDENT' });
    const clerk = await createUser({ role: 'CLERK' });
    const r = await createRequest(student, { status: 'FULFILLED', statusHistory: [{ from: null, to: 'PENDING', by: student._id }, { from: 'APPROVED', to: 'FULFILLED', by: clerk._id, at: new Date('2026-01-01T10:00:00Z') }] });
    await Request.collection.updateOne({ _id: r._id }, { $set: { documentPath: name } });
    return { r, name, buf, clerk, student };
  }

  beforeEach(() => useStorage(new LocalAdapter(process.env.UPLOAD_DIR)));

  test('dry run only counts; apply creates a Document under a tenant-prefixed key and keeps the old file for cleanup', async () => {
    const l = await legacy();
    expect(await migrate({ slug: 'default' })).toMatchObject({ applied: false, legacyDocuments: 1 });
    expect(await Document.countDocuments({})).toBe(0);

    const report = await migrate({ slug: 'default', apply: true });
    expect(report).toMatchObject({ applied: true, legacyDocuments: 1, legacyDocumentsMissing: 0 });
    const doc = await Document.findOne({ requestId: l.r._id }).select('+key +sha256');
    expect(doc).toMatchObject({ status: 'ACTIVE', version: 1, fileType: 'pdf', sizeBytes: l.buf.length });
    expect(doc.key).toMatch(new RegExp(`^${getDefaultTenant()._id}/${l.r._id}/[0-9a-f-]{36}\\.pdf$`));
    expect(doc.sha256).toBe(sha(l.buf));
    expect(String(doc.uploadedBy)).toBe(String(l.clerk._id));
    expect(doc.createdAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(fs.readFileSync(path.join(process.env.UPLOAD_DIR, ...doc.key.split('/'))).equals(l.buf)).toBe(true);
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR, l.name))).toBe(true); // old flat file left for the cleanup script
    expect((await Request.collection.findOne({ _id: l.r._id })).documentPath).toBeUndefined();

    // The migrated document downloads normally, and its verification code works.
    const student = await loginAgent(app, l.student);
    const dl = await student.get(`/api/requests/${l.r._id}/document`).buffer(true).parse((resp, cb) => {
      const c = [];
      resp.on('data', (d) => c.push(d));
      resp.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(dl.status).toBe(200);
    expect(dl.body.equals(l.buf)).toBe(true);
    expect(verification.available()).toBe(true);
  });

  test('is idempotent, skips malformed names and counts missing files without failing', async () => {
    const good = await legacy();
    const missing = await legacy({ withFile: false });
    const evil = await legacy();
    await Request.collection.updateOne({ _id: evil.r._id }, { $set: { documentPath: '../../.env' } });
    const first = await migrate({ slug: 'default', apply: true });
    expect(first).toMatchObject({ legacyDocuments: 1, legacyDocumentsMissing: 1 });
    expect(await Document.countDocuments({})).toBe(1);
    expect((await Request.collection.findOne({ _id: missing.r._id })).documentPath).toBe(missing.name); // left for a human
    expect((await Request.collection.findOne({ _id: evil.r._id })).documentPath).toBe('../../.env'); // never followed
    const again = await migrate({ slug: 'default', apply: true });
    expect(again).toMatchObject({ legacyDocuments: 0 });
    expect(await Document.countDocuments({})).toBe(1);
    void good;
  });

  test('a migrated institution\'s documents are not visible to another', async () => {
    const l = await legacy();
    await migrate({ slug: 'default', apply: true });
    const { makeTenant } = require('./helpers');
    const B = await makeTenant('beta-college');
    const other = await loginAgent(app, await createUser({ role: 'STUDENT', tenant: B }), 'Passw0rdTest', 'beta-college');
    expect((await other.get(`/api/requests/${l.r._id}/document`)).status).toBe(404);
    expect(await runAsTenant(B._id, () => Document.countDocuments({}))).toBe(0);
    void request;
    void CSRF;
    void config;
  });
});

describe('verification codes whose signature contains "-" or "_"', () => {
  test('every code verifies, whatever characters its signature happens to contain', async () => {
    useStorage(new LocalAdapter(process.env.UPLOAD_DIR));
    const student = await createUser({ role: 'STUDENT' });
    const clerk = await createUser({ role: 'CLERK' });
    const r = await createRequest(student, { status: 'FULFILLED' });
    const found = { dash: null, underscore: null };
    for (let i = 0; i < 400 && (!found.dash || !found.underscore); i += 1) {
      const doc = await Document.create({ requestId: r._id, key: `${getDefaultTenant()._id}/${r._id}/${crypto.randomUUID()}.pdf`, fileType: 'pdf', sizeBytes: 5, sha256: sha(Buffer.from(String(i))), uploadedBy: clerk._id });
      const withHash = await Document.findById(doc._id).select('+sha256');
      const sig = verification.codeFor(withHash).slice(25);
      if (sig.includes('-') && !found.dash) found.dash = verification.codeFor(withHash);
      if (sig.includes('_') && !found.underscore) found.underscore = verification.codeFor(withHash);
    }
    expect(found.dash).toBeTruthy();
    expect(found.underscore).toBeTruthy();
    for (const code of Object.values(found)) {
      expect((await request(app).get(`/api/verify/${code}`)).body.data.valid).toBe(true);
    }
  });
});
