'use strict';

process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { startDb, stopDb, clearDb, createUser, createRequest, makeTenant } = require('./helpers');
const { backupDb, restoreDb, verifyBackup, verifyAuditChains, drill } = require('../ops/backup');
const auditService = require('../services/auditService');
const { runAsTenant } = require('../utils/tenantContext');

const KEY = 'k'.repeat(40);
let work;
let client;
let sourceName;
const dropped = [];

beforeAll(async () => {
  await startDb();
  client = mongoose.connection.getClient();
  sourceName = mongoose.connection.db.databaseName;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-backup-test-'));
});
afterAll(async () => {
  for (const n of dropped) await client.db(n).dropDatabase().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
  await stopDb();
});
beforeEach(clearDb);

async function seed() {
  const student = await createUser({ role: 'STUDENT', email: 'seed.student@example.com' });
  const req = await createRequest(student);
  await auditService.record({ actorId: student._id, action: 'REQUEST_SUBMITTED', requestId: req._id, details: { documentType: 'Bonafide Certificate' } });
  await auditService.record({ actorId: student._id, action: 'USER_LOGIN', details: {} });
  const other = await makeTenant('second-college');
  await runAsTenant(other._id, () => auditService.record({ actorId: student._id, action: 'USER_LOGIN', details: { n: 1 } }));
  return { student, req };
}
const newDir = (n) => path.join(work, `${n}-${Math.random().toString(36).slice(2, 8)}`);
const freshDb = () => {
  const n = `${sourceName}_drill_${Math.random().toString(36).slice(2, 8)}`;
  dropped.push(n);
  return client.db(n);
};

describe('backup and restore', () => {
  test('a restore reproduces every collection exactly, including ids, dates and indexes', async () => {
    const { student } = await seed();
    const dir = newDir('exact');
    const made = await backupDb(mongoose.connection.db, dir);
    expect(made.documents).toBeGreaterThan(5);
    const target = freshDb();
    const res = await restoreDb(target, dir);
    expect(res.documents).toBe(made.documents);

    const src = await mongoose.connection.db.collection('users').findOne({ _id: student._id });
    const dst = await target.collection('users').findOne({ _id: student._id });
    expect(dst).toEqual(src); // ObjectIds and Dates survived as real types
    expect(dst.createdAt instanceof Date).toBe(true);
    const idx = (await target.collection('users').indexes()).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining((await mongoose.connection.db.collection('users').indexes()).map((i) => i.name)));
  });

  test('restored audit chains verify, per institution', async () => {
    await seed();
    const dir = newDir('chain');
    await backupDb(mongoose.connection.db, dir);
    const target = freshDb();
    await restoreDb(target, dir);
    const v = await verifyAuditChains(target);
    expect(v).toMatchObject({ ok: true, tenants: 2 });
    expect(v.entries).toBeGreaterThanOrEqual(3);
  });

  test('refuses to restore into a database that already has data', async () => {
    await seed();
    const dir = newDir('nonempty');
    await backupDb(mongoose.connection.db, dir);
    await expect(restoreDb(mongoose.connection.db, dir)).rejects.toThrow(/not empty/);
    const target = freshDb();
    await restoreDb(target, dir);
    await expect(restoreDb(target, dir)).rejects.toThrow(/not empty/);
  });

  test('refuses to write a backup into a folder that already has files', async () => {
    await seed();
    const dir = newDir('reuse');
    await backupDb(mongoose.connection.db, dir);
    await expect(backupDb(mongoose.connection.db, dir)).rejects.toThrow(/not empty/);
  });

  test('a damaged file is detected before anything is written', async () => {
    await seed();
    const dir = newDir('damaged');
    await backupDb(mongoose.connection.db, dir);
    fs.appendFileSync(path.join(dir, 'users.ndjson'), '{"x":1}\n');
    await expect(verifyBackup(dir)).rejects.toThrow(/checksum mismatch/);
    const target = freshDb();
    await expect(restoreDb(target, dir)).rejects.toThrow(/checksum mismatch/);
    expect(await target.listCollections().toArray()).toHaveLength(0);
  });

  test('a missing file or manifest is an error, not a partial restore', async () => {
    await seed();
    const dir = newDir('missing');
    await backupDb(mongoose.connection.db, dir);
    fs.rmSync(path.join(dir, 'requests.ndjson'));
    await expect(verifyBackup(dir)).rejects.toThrow();
    fs.rmSync(path.join(dir, 'manifest.json'));
    await expect(verifyBackup(dir)).rejects.toThrow();
  });

  test('the sample audit tamper is caught in the restored copy', async () => {
    await seed();
    await mongoose.connection.db.collection('auditlogs').updateOne({ action: 'USER_LOGIN' }, { $set: { action: 'USER_DEACTIVATED' } });
    const dir = newDir('tamper');
    await backupDb(mongoose.connection.db, dir);
    const target = freshDb();
    await restoreDb(target, dir);
    const v = await verifyAuditChains(target);
    expect(v.ok).toBe(false);
    expect(v.broken.length).toBeGreaterThan(0);
  });
});

describe('encrypted backups', () => {
  test('files hold no readable data, restore with the key, fail without or with a wrong key', async () => {
    await seed();
    const dir = newDir('enc');
    const made = await backupDb(mongoose.connection.db, dir, { encryptionKey: KEY });
    expect(made.encrypted).toBe(true);
    const raw = fs.readFileSync(path.join(dir, 'users.ndjson'), 'latin1');
    expect(raw).not.toMatch(/seed\.student@example\.com|passwordHash|STUDENT/);

    await expect(restoreDb(freshDb(), dir)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is required/);
    await expect(restoreDb(freshDb(), dir, { encryptionKey: 'z'.repeat(40) })).rejects.toThrow();
    const target = freshDb();
    const res = await restoreDb(target, dir, { encryptionKey: KEY });
    expect(res.documents).toBe(made.documents);
    expect(await target.collection('users').countDocuments({ email: 'seed.student@example.com' })).toBe(1);
  });

  test('a short key is refused', async () => {
    await expect(backupDb(mongoose.connection.db, newDir('short'), { encryptionKey: 'short' })).rejects.toThrow(/at least 32/);
  });
});

describe('restore drill', () => {
  test('passes on healthy data, cleans up after itself, and does not touch the source', async () => {
    await seed();
    const before = await mongoose.connection.db.collection('users').countDocuments({});
    const dbsBefore = (await client.db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.includes('_drill_'));
    const r = await drill(client, sourceName, work);
    expect(r).toMatchObject({ ok: true, mismatches: [] });
    expect(r.auditChains.ok).toBe(true);
    expect(await mongoose.connection.db.collection('users').countDocuments({})).toBe(before);
    const dbsAfter = (await client.db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.includes('_drill_'));
    expect(dbsAfter.length).toBeLessThanOrEqual(dbsBefore.length);
  });

  test('fails loudly when the audit chain in the data is broken', async () => {
    await seed();
    await mongoose.connection.db.collection('auditlogs').updateOne({ action: 'REQUEST_SUBMITTED' }, { $set: { details: { documentType: 'Forged' } } });
    const r = await drill(client, sourceName, work);
    expect(r.ok).toBe(false);
    expect(r.auditChains.ok).toBe(false);
  });

  test('works on an empty database too', async () => {
    const r = await drill(client, sourceName, work);
    expect(r.ok).toBe(true);
  });
});
