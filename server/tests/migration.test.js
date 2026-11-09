'use strict';

// S1: the one-off migration of single-tenant MVP data. Legacy documents are inserted with
// native calls (no tenantId field), exactly as the MVP stored them.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { startDb, stopDb, clearDb, makeApp, CSRF, request, runUnscoped } = require('./helpers');
const { setTestFallback } = require('../utils/tenantContext');
const { migrate } = require('../../scripts/migrateToTenants');
const User = require('../models/User');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const Tenant = require('../models/Tenant');
const bcrypt = require('bcryptjs');

beforeAll(async () => {
  await startDb();
  setTestFallback(null);
});
afterAll(stopDb);
beforeEach(clearDb);

async function legacyData() {
  const hash = await bcrypt.hash('Passw0rdTest', 4);
  const now = new Date();
  const ids = { student: new mongoose.Types.ObjectId(), admin: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId(), req: new mongoose.Types.ObjectId() };
  await User.collection.insertMany([
    { _id: ids.student, name: 'Old Student', email: 'old.student@example.com', passwordHash: hash, role: 'STUDENT', department: 'CSE', isActive: true, createdAt: now, updatedAt: now },
    { _id: ids.admin, name: 'Old Admin', email: 'old.admin@example.com', passwordHash: hash, role: 'ADMIN', department: null, isActive: true, createdAt: now, updatedAt: now },
  ]);
  // A platform owner already created after S1: has the field set to null, must stay tenantless.
  await User.collection.insertOne({ _id: ids.owner, name: 'Owner', email: 'owner@example.com', passwordHash: hash, role: 'SUPER_ADMIN', tenantId: null, isActive: true, createdAt: now, updatedAt: now });
  await Request.collection.insertOne({
    _id: ids.req, studentId: ids.student, department: 'CSE', documentType: 'Transcript', purpose: 'Legacy request from the MVP',
    status: 'PENDING', statusHistory: [{ from: null, to: 'PENDING', by: ids.student, at: now }], createdAt: now, updatedAt: now,
  });
  await AuditLog.collection.insertOne({ actorId: ids.student, action: 'USER_LOGIN', requestId: null, details: {}, timestamp: now });
  return ids;
}

describe('migrateToTenants', () => {
  test('dry run reports counts and changes nothing', async () => {
    await legacyData();
    const report = await migrate({ slug: 'old-college', name: 'Old College' });
    expect(report).toMatchObject({ applied: false, users: 2, requests: 1, auditLogs: 1, createdTenant: true });
    expect(await runUnscoped(() => Tenant.countDocuments({ slug: 'old-college' }))).toBe(0);
    expect(await User.collection.countDocuments({ tenantId: { $exists: false } })).toBe(2);
  });

  test('apply creates the tenant and back-fills every legacy record, leaving SUPER_ADMIN alone', async () => {
    const ids = await legacyData();
    const report = await migrate({ slug: 'old-college', name: 'Old College', apply: true });
    expect(report).toMatchObject({ applied: true, users: 2, requests: 1, auditLogs: 1 });
    const tenant = await runUnscoped(() => Tenant.findOne({ slug: 'old-college' }));
    expect(tenant.name).toBe('Old College');
    for (const [coll, filter] of [[User, { role: { $ne: 'SUPER_ADMIN' } }], [Request, {}], [AuditLog, {}]]) {
      expect(await coll.collection.countDocuments({ ...filter, tenantId: tenant._id })).toBeGreaterThan(0);
      expect(await coll.collection.countDocuments({ ...filter, tenantId: { $exists: false } })).toBe(0);
    }
    const owner = await User.collection.findOne({ _id: ids.owner });
    expect(owner.tenantId).toBeNull();
  });

  test('is idempotent: a second run changes nothing and creates no second tenant', async () => {
    await legacyData();
    await migrate({ slug: 'old-college', apply: true });
    const again = await migrate({ slug: 'old-college', apply: true });
    expect(again).toMatchObject({ users: 0, requests: 0, auditLogs: 0, createdTenant: false });
    expect(await runUnscoped(() => Tenant.countDocuments({ slug: 'old-college' }))).toBe(1);
  });

  test('migrated users can sign in at the institution address and see their legacy request', async () => {
    await legacyData();
    await migrate({ slug: 'old-college', apply: true });
    const app = makeApp({ authRateLimitMax: 1000 });
    const agent = request.agent(app, 'old-college');
    const login = await agent.post('/api/auth/login').set(CSRF).send({ email: 'old.student@example.com', password: 'Passw0rdTest' });
    expect(login.status).toBe(200);
    const list = await agent.get('/api/requests');
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].purpose).toBe('Legacy request from the MVP');
  });

  test('replaces the old global-unique email index so two institutions can share an email', async () => {
    await legacyData();
    await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    expect((await migrate({ slug: 'old-college' })).droppedEmailIndex).toBe(true);
    const report = await migrate({ slug: 'old-college', apply: true });
    expect(report.droppedEmailIndex).toBe(true);
    const names = (await User.collection.indexes()).map((i) => i.name);
    expect(names).not.toContain('email_1');
    expect(names).toContain('tenantId_1_email_1');
    const hash = await bcrypt.hash('Passw0rdTest', 4);
    const other = await runUnscoped(() => Tenant.create({ slug: 'second-college', name: 'Second College' }));
    await expect(
      User.collection.insertOne({ name: 'Twin', email: 'old.student@example.com', passwordHash: hash, role: 'STUDENT', department: 'CSE', tenantId: other._id })
    ).resolves.toBeDefined();
  });
});
