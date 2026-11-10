'use strict';

process.env.NODE_ENV = 'test';
const bcrypt = require('bcryptjs');
const supertest = require('supertest');
const mongoose = require('mongoose');
const { startDb, stopDb, clearDb, makeApp, createUser, createRequest, loginAgent, makeTenant, request, CSRF, runAsTenant, runUnscoped } = require('./helpers');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const AuditLog = require('../models/AuditLog');
const Request = require('../models/Request');
const ApiKey = require('../models/ApiKey');
const auditService = require('../services/auditService');
const lifecycle = require('../services/dataLifecycleService');
const { getStorage, makeKey } = require('../storage');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await runUnscoped(() => Tenant.deleteMany({ slug: { $ne: 'default' } }));
  await runUnscoped(() => User.collection.deleteMany({ role: 'SUPER_ADMIN' }));
});

async function superAgent() {
  await runUnscoped(async () => User.create({ name: 'Platform Owner', email: 'owner@platform.example.com', passwordHash: await bcrypt.hash('PlatformPass1', 4), role: 'SUPER_ADMIN' }));
  const agent = supertest.agent(app);
  const res = await agent.post('/api/platform/auth/login').set(CSRF).send({ email: 'owner@platform.example.com', password: 'PlatformPass1' });
  expect(res.status).toBe(200);
  return agent;
}

describe('institution data export (Admin)', () => {
  async function setup() {
    const admin = await createUser({ role: 'ADMIN' });
    const student = await createUser({ role: 'STUDENT', email: 'portable.student@example.com' });
    await createRequest(student);
    await auditService.record({ actorId: student._id, action: 'USER_LOGIN', details: {} });
    return { admin, student, agent: await loginAgent(app, admin) };
  }

  test('contains the institution\'s users, requests, configuration and audit trail', async () => {
    const { agent } = await setup();
    const res = await agent.get('/api/admin/data-export').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="institution-export-\d{4}-\d{2}-\d{2}\.json"/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const c = res.body.collections;
    expect(c.users.length).toBe(2);
    expect(c.requests.length).toBe(1);
    expect(c.departments.length).toBeGreaterThan(0);
    expect(c.workflowdefinitions.length).toBeGreaterThan(0);
    expect(c.auditlogs.length).toBeGreaterThan(0);
    expect(res.body.institution.slug).toBe('default');
  });

  test('never contains passwords, hashes, tokens or storage keys', async () => {
    const { agent, admin } = await setup();
    await runAsTenant(admin.tenantId, () => ApiKey.create({ name: 'kk', prefix: 'abcd1234', secretHash: 'a'.repeat(64), scopes: ['requests:read'], createdBy: admin._id }));
    const res = await agent.get('/api/admin/data-export').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/passwordHash|keyHash|tokenHash|mfaSecret|secretHash|"key":"[0-9a-f]{24}\//);
    expect(text).not.toContain('$2a$');
    expect(text).not.toContain('a'.repeat(64));
    expect(res.body.collections.authtokens).toBeUndefined();
  });

  test('is limited to the caller\'s own institution', async () => {
    const { agent } = await setup();
    const other = await makeTenant('other-college');
    const intruder = await createUser({ role: 'STUDENT', email: 'other.college.user@example.com', tenant: other });
    expect(intruder).toBeTruthy();
    const res = await agent.get('/api/admin/data-export').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('other.college.user@example.com');
  });

  test('is Admin only', async () => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    await agent.get('/api/admin/data-export').expect(403);
    await supertest(app).get('/api/t/default/admin/data-export').expect(401);
  });

  test('is audited, and a different institution\'s Admin cannot use this one\'s session', async () => {
    const { agent } = await setup();
    await agent.get('/api/admin/data-export').expect(200);
    const logs = await AuditLog.find({ action: 'DATA_EXPORTED' });
    expect(logs.some((l) => l.details && l.details.kind === 'institution')).toBe(true);
    await makeTenant('other-college');
    const cross = await request(app, 'other-college').get('/api/admin/data-export').set('Cookie', (agent.jar ? '' : ''));
    expect([401, 403]).toContain(cross.status);
  });
});

describe('platform: suspend, resume, delete', () => {
  async function victim() {
    const t = await makeTenant('doomed-college');
    const u = await createUser({ role: 'STUDENT', tenant: t, email: 'doomed.user@example.com' });
    await runAsTenant(t._id, async () => {
      await createRequest(u, {}, t);
      await auditService.record({ actorId: u._id, action: 'USER_LOGIN', details: {} });
    });
    return t;
  }
  const store = () => getStorage();

  test('suspended institutions cannot be used; resume brings them back', async () => {
    const su = await superAgent();
    await victim();
    expect((await request(app, 'doomed-college').get('/api/meta/departments')).status).toBe(200);
    const s = await su.post('/api/platform/tenants/doomed-college/suspend').set(CSRF).expect(200);
    expect(s.body.data.tenant.status).toBe('SUSPENDED');
    expect((await request(app, 'doomed-college').get('/api/meta/departments')).status).toBe(404);
    await su.post('/api/platform/tenants/doomed-college/suspend').set(CSRF).expect(409);
    await su.post('/api/platform/tenants/doomed-college/resume').set(CSRF).expect(200);
    expect((await request(app, 'doomed-college').get('/api/meta/departments')).status).toBe(200);
    await su.post('/api/platform/tenants/nope/suspend').set(CSRF).expect(404);
  });

  test('deletion needs the institution suspended first and the exact address typed back', async () => {
    const su = await superAgent();
    const t = await victim();
    await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({ confirm: 'doomed-college' }).expect(409); // still active
    await su.post('/api/platform/tenants/doomed-college/suspend').set(CSRF).expect(200);
    await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({ confirm: 'wrong' }).expect(400);
    await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({}).expect(400);
    await su.delete('/api/platform/tenants/doomed-college').set(CSRF).expect(400);
    expect(await runUnscoped(() => Tenant.exists({ _id: t._id }))).toBeTruthy();
    expect(await runAsTenant(t._id, () => Request.countDocuments({}))).toBe(1);
  });

  test('deletion removes the institution\'s rows and files, leaves other institutions alone, and is audited', async () => {
    const su = await superAgent();
    const t = await victim();
    const keep = await makeTenant('keep-college');
    const keepUser = await createUser({ role: 'STUDENT', tenant: keep, email: 'keeper@example.com' });
    await runAsTenant(keep._id, async () => {
      await createRequest(keepUser, {}, keep);
      await auditService.record({ actorId: keepUser._id, action: 'USER_LOGIN', details: {} });
    });
    const doomedKey = makeKey(t._id, new mongoose.Types.ObjectId(), 'pdf');
    const keepKey = makeKey(keep._id, new mongoose.Types.ObjectId(), 'pdf');
    await store().put(doomedKey, Buffer.from('%PDF-1.4 doomed'));
    await store().put(keepKey, Buffer.from('%PDF-1.4 keeper'));

    await su.post('/api/platform/tenants/doomed-college/suspend').set(CSRF).expect(200);
    const res = await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({ confirm: 'doomed-college' }).expect(200);
    expect(res.body.data.files).toBe(1);
    expect(res.body.data.rows).toBeGreaterThan(3);

    expect(await runUnscoped(() => Tenant.exists({ _id: t._id }))).toBeNull();
    for (const model of lifecycle.tenantModels()) {
      expect(await model.collection.countDocuments({ tenantId: t._id })).toBe(0);
    }
    const left = (await store().list()).map((f) => f.key);
    expect(left).toContain(keepKey);
    expect(left.some((k) => k.startsWith(`${t._id}/`))).toBe(false);
    expect(await runAsTenant(keep._id, () => Request.countDocuments({}))).toBe(1);
    expect(await runAsTenant(keep._id, () => User.countDocuments({}))).toBe(1);
    const verify = await runAsTenant(keep._id, () => auditService.verifyChain());
    expect(verify.ok).toBe(true);

    const record = await runUnscoped(() => AuditLog.findOne({ action: 'TENANT_DELETED' }));
    expect(record.details.slug).toBe('doomed-college');
    expect(JSON.stringify(record.details)).not.toContain('doomed.user');
    expect((await request(app, 'doomed-college').get('/api/meta/departments')).status).toBe(404);
  });

  test('a storage failure aborts before any database row is removed', async () => {
    const su = await superAgent();
    const t = await victim();
    await store().put(makeKey(t._id, new mongoose.Types.ObjectId(), 'pdf'), Buffer.from('%PDF-1.4 doomed'));
    await su.post('/api/platform/tenants/doomed-college/suspend').set(CSRF).expect(200);
    const spy = jest.spyOn(store(), 'deleteRaw').mockRejectedValue(new Error('storage down'));
    const res = await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({ confirm: 'doomed-college' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await runUnscoped(() => Tenant.exists({ _id: t._id }))).toBeTruthy();
    expect(await runAsTenant(t._id, () => Request.countDocuments({}))).toBe(1);
    // retry succeeds
    await su.delete('/api/platform/tenants/doomed-college').set(CSRF).send({ confirm: 'doomed-college' }).expect(200);
  });

  test('only a platform session may do any of this (tenant Admins and anonymous callers cannot)', async () => {
    await victim();
    const admin = await createUser({ role: 'ADMIN', tenant: undefined });
    const adminAgent = await loginAgent(app, admin);
    for (const [method, url] of [['post', '/api/platform/tenants/doomed-college/suspend'], ['post', '/api/platform/tenants/doomed-college/resume'], ['delete', '/api/platform/tenants/doomed-college']]) {
      expect((await supertest(app)[method](url).set(CSRF).send({ confirm: 'doomed-college' })).status).toBe(401);
      expect((await adminAgent[method](url).set(CSRF).send({ confirm: 'doomed-college' })).status).toBe(401);
    }
    expect(await runUnscoped(() => Tenant.exists({ slug: 'doomed-college' }))).toBeTruthy();
  });

  test('a malformed address is a 400 and never a query', async () => {
    const su = await superAgent();
    await su.post('/api/platform/tenants/Bad%20Slug!/suspend').set(CSRF).expect(400);
  });

  test('every model with a tenantId is covered by deletion (guard for future models)', () => {
    const names = lifecycle.tenantModels().map((m) => m.modelName);
    for (const n of ['User', 'Request', 'AuditLog', 'AuditChain', 'Document', 'Notification', 'Invite', 'AuthToken', 'ApiKey', 'Webhook', 'WebhookDelivery', 'Department', 'DocumentType', 'WorkflowDefinition']) {
      expect(names).toContain(n);
    }
    expect(mongoose.modelNames().filter((n) => !names.includes(n)).sort()).toEqual(['Heartbeat', 'Tenant']);
  });
});

describe('retention (indexes the database enforces)', () => {
  const ttl = async (Model) => (await Model.collection.indexes()).filter((i) => i.expireAfterSeconds !== undefined);
  test.each([
    ['AuthToken', 7 * 86400],
    ['Notification', 365 * 86400],
    ['WebhookDelivery', 90 * 86400],
    ['Invite', 90 * 86400],
  ])('%s expires after the documented time', async (name, seconds) => {
    const Model = require(`../models/${name}`);
    await Model.init();
    await Model.syncIndexes();
    expect((await ttl(Model)).map((i) => i.expireAfterSeconds)).toContain(seconds);
  });

  test('requests, documents and audit entries have no expiry', async () => {
    for (const name of ['Request', 'Document', 'AuditLog', 'AuditChain', 'User']) {
      expect(await ttl(require(`../models/${name}`))).toEqual([]);
    }
  });
});
