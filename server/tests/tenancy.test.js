'use strict';

// S1 gate: tenant A can never read, change or download tenant B's users, requests,
// documents or audit entries, and the tenant plumbing itself fails closed.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, forgeToken, request,
  makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const { setTestFallback } = require('../utils/tenantContext');
const config = require('../config/env');
const User = require('../models/User');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const Tenant = require('../models/Tenant');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
  // This file proves isolation, so it must not lean on the test-only default tenant:
  // every model call below names its tenant (or runUnscoped) explicitly.
  setTestFallback(null);
});
afterAll(stopDb);
beforeEach(clearDb);

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

// Two institutions with a full cast each. Tenant B also has a fulfilled request with a document.
async function twoTenants() {
  const A = getDefaultTenant();
  const B = await makeTenant('beta-college', 'Beta College');
  const cast = async (tenant) => ({
    admin: await createUser({ role: 'ADMIN', tenant }),
    clerk: await createUser({ role: 'CLERK', department: 'CSE', tenant }),
    hod: await createUser({ role: 'HOD', department: 'CSE', tenant }),
    student: await createUser({ role: 'STUDENT', department: 'CSE', tenant }),
  });
  const a = await cast(A);
  const b = await cast(B);
  const bReq = await createRequest(b.student, { status: 'UNDER_REVIEW' }, B);
  const bDone = await createRequest(b.student, { status: 'FULFILLED', documentPath: '11111111-1111-4111-8111-111111111111.pdf' }, B);
  const aReq = await createRequest(a.student, {}, A);
  return { A, B, a, b, bReq, bDone, aReq };
}

describe('tenant scoping plugin (unit)', () => {
  test('(unit) a query with no tenant context is refused', async () => {
    setTestFallback(null);
    await expect(User.find({})).rejects.toThrow(/Tenant context missing/);
    await expect(Request.countDocuments()).rejects.toThrow(/Tenant context missing/);
    await expect(AuditLog.find()).rejects.toThrow(/Tenant context missing/);
    await expect(User.aggregate([{ $match: {} }])).rejects.toThrow(/Tenant context missing/);
  });

  test('(unit) creating a record with no tenant context is refused', async () => {
    setTestFallback(null);
    await expect(Request.create({})).rejects.toThrow(/Tenant context missing/);
  });

  test('(unit) queries only see the current tenant, even when the filter names another tenant', async () => {
    const { A, B, a, b } = await twoTenants();
    const inA = await runAsTenant(A._id, () => User.find({}));
    expect(inA.map((u) => String(u._id)).sort()).toEqual(Object.values(a).map((u) => String(u._id)).sort());
    // A caller-supplied tenantId is overridden, not trusted.
    const sneaky = await runAsTenant(A._id, () => User.find({ tenantId: B._id }));
    expect(sneaky.map((u) => String(u._id)).sort()).toEqual(inA.map((u) => String(u._id)).sort());
    expect(await runAsTenant(A._id, () => User.findById(b.admin._id))).toBeNull();
    expect(await runAsTenant(B._id, () => User.countDocuments())).toBe(4);
  });

  test('(unit) updates and deletes cannot touch another tenant, nor move a record between tenants', async () => {
    const { A, B, b } = await twoTenants();
    const res = await runAsTenant(A._id, () => User.updateOne({ _id: b.student._id }, { name: 'Hijacked' }));
    expect(res.matchedCount).toBe(0);
    await runAsTenant(A._id, () => User.deleteMany({}));
    expect(await runAsTenant(B._id, () => User.countDocuments())).toBe(4);
    await expect(runAsTenant(B._id, () => User.updateOne({ _id: b.student._id }, { tenantId: A._id }))).rejects.toThrow(/tenantId cannot be changed/);
    await expect(runAsTenant(B._id, () => User.updateOne({ _id: b.student._id }, { $set: { tenantId: A._id } }))).rejects.toThrow(/tenantId cannot be changed/);
  });

  test('(unit) aggregates are scoped and new records are stamped with the context tenant', async () => {
    const { A, B } = await twoTenants();
    const counted = await runAsTenant(A._id, () => Request.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]));
    expect(counted[0].n).toBe(1); // only A's single request
    const stamped = await runAsTenant(B._id, () => AuditLog.create({ actorId: new mongoose.Types.ObjectId(), action: 'USER_LOGIN' }));
    expect(String(stamped.tenantId)).toBe(String(B._id));
    await expect(runAsTenant(A._id, () => Request.create({ tenantId: B._id }))).rejects.toThrow(/another tenant/);
  });

  test('(unit) bulk writes are refused in tenant mode', async () => {
    const { A } = await twoTenants();
    await expect(runAsTenant(A._id, () => User.insertMany([{ name: 'x' }]))).rejects.toThrow(/not allowed in tenant mode/);
  });

  test('(unit) email is unique per tenant, not globally', async () => {
    const A = getDefaultTenant();
    const B = await makeTenant('gamma-college');
    await createUser({ email: 'same@example.com', tenant: A });
    await expect(createUser({ email: 'same@example.com', tenant: B })).resolves.toBeDefined();
    await expect(createUser({ email: 'same@example.com', tenant: A })).rejects.toThrow(/duplicate key/);
  });
});

describe('tenant resolution', () => {
  test('unknown, malformed and suspended institutions all answer the same 404', async () => {
    const t = await makeTenant('paused-college');
    await runUnscoped(() => Tenant.updateOne({ _id: t._id }, { status: 'SUSPENDED' }));
    const login = (slug) => request(app, slug).post('/api/auth/login').set(CSRF).send({ email: 'a@b.com', password: 'Passw0rd1' });
    const bodies = [];
    for (const slug of ['no-such-college', 'paused-college', 'Bad_Slug!', 'x']) {
      const res = await login(slug);
      expect(res.status).toBe(404);
      bodies.push(res.body.message);
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test('the old un-prefixed API paths are gone', async () => {
    const res = await request(app).post('/api/t/../auth/login').set(CSRF).send({});
    expect([400, 404]).toContain(res.status);
    const raw = await require('supertest')(app).post('/api/auth/login').set(CSRF).send({ email: 'a@b.com', password: 'Passw0rd1' });
    expect(raw.status).toBe(404);
  });

  test('the same email can have different passwords in two institutions', async () => {
    const B = await makeTenant('delta-college');
    await createUser({ email: 'dual@example.com', password: 'PasswordA1', tenant: getDefaultTenant() });
    await createUser({ email: 'dual@example.com', password: 'PasswordB2', tenant: B });
    const inA = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'dual@example.com', password: 'PasswordA1' });
    const crossA = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'dual@example.com', password: 'PasswordB2' });
    const inB = await request(app, 'delta-college').post('/api/auth/login').set(CSRF).send({ email: 'dual@example.com', password: 'PasswordB2' });
    expect(inA.status).toBe(200);
    expect(crossA.status).toBe(401);
    expect(inB.status).toBe(200);
  });

  test("a user of tenant A cannot sign in at tenant B's address", async () => {
    const { a } = await twoTenants();
    const res = await request(app, 'beta-college').post('/api/auth/login').set(CSRF).send({ email: a.student.email, password: 'Passw0rdTest' });
    expect(res.status).toBe(401);
  });
});

describe('sessions do not cross tenants', () => {
  test("a valid session for tenant A is rejected at tenant B on every authenticated endpoint", async () => {
    const { a, b, bReq, bDone } = await twoTenants();
    const token = forgeToken(a.admin._id); // genuine signature, tenant A claim
    const probes = [
      ['get', '/api/auth/me'],
      ['get', '/api/admin/users'],
      ['get', '/api/admin/audit-logs'],
      ['patch', `/api/admin/users/${b.student._id}`],
      ['get', '/api/requests'],
      ['get', `/api/requests/${bReq._id}`],
      ['get', `/api/requests/${bDone._id}/document`],
      ['patch', `/api/requests/${bReq._id}/approve`],
    ];
    for (const [method, url] of probes) {
      const res = await request(app, 'beta-college')[method](url).set(CSRF).set('Cookie', `${config.cookieName}=${token}`).send({});
      expect([url, res.status]).toEqual([url, 401]);
    }
  });

  test('a token without a tenant claim (a pre-tenant session) is rejected', async () => {
    const { a } = await twoTenants();
    const jwt = require('jsonwebtoken');
    const old = jwt.sign({ sub: String(a.admin._id) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/api/auth/me').set('Cookie', `${config.cookieName}=${old}`);
    expect(res.status).toBe(401);
  });

  test("the session cookie is scoped to one institution's API path", async () => {
    const { a } = await twoTenants();
    const res = await require('supertest')(app).post('/api/t/default/auth/login').set(CSRF).send({ email: a.admin.email, password: 'Passw0rdTest' });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith(config.cookieName));
    expect(cookie).toMatch(/Path=\/api\/t\/default/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });
});

describe("cross-tenant access: tenant A's users against tenant B's data (same departments)", () => {
  test("A's admin sees only A's users and audit entries, and cannot change B's users", async () => {
    const { a, b } = await twoTenants();
    const agent = await loginAgent(app, a.admin);
    const users = await agent.get('/api/admin/users?limit=100');
    expect(users.status).toBe(200);
    const ids = users.body.data.items.map((u) => u._id);
    expect(ids).toHaveLength(4);
    for (const u of Object.values(b)) expect(ids).not.toContain(String(u._id));

    const patch = await agent.patch(`/api/admin/users/${b.student._id}`).set(CSRF).send({ isActive: false });
    expect(patch.status).toBe(404);
    expect((await runAsTenant(getDefaultTenant()._id, () => User.countDocuments({}))) ).toBe(4);
    expect((await runUnscoped(() => User.findById(b.student._id))).isActive).toBe(true);

    // Audit trail: write something in B, confirm A cannot see it.
    await runAsTenant(b.admin.tenantId, () => AuditLog.create({ actorId: b.admin._id, action: 'USER_ACTIVATED', details: { marker: 'tenant-b-only' } }));
    const audit = await agent.get('/api/admin/audit-logs?limit=100');
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain('tenant-b-only');
    for (const item of audit.body.data.items) expect(String(item.tenantId)).toBe(String(getDefaultTenant()._id));
  });

  test("A's staff and students get 404 for B's request on every route, and B's request never changes", async () => {
    const { a, bReq, bDone } = await twoTenants();
    const clerk = await loginAgent(app, a.clerk);
    const hod = await loginAgent(app, a.hod);
    const student = await loginAgent(app, a.student);
    const admin = await loginAgent(app, a.admin);

    for (const who of [clerk, hod, student, admin]) {
      expect((await who.get(`/api/requests/${bReq._id}`)).status).toBe(404);
    }
    // Admins have no document access at all (403); everyone else gets 404 for B's document.
    for (const who of [clerk, hod, student]) {
      expect((await who.get(`/api/requests/${bDone._id}/document`)).status).toBe(404);
    }
    expect((await admin.get(`/api/requests/${bDone._id}/document`)).status).toBe(403);
    expect((await clerk.patch(`/api/requests/${bReq._id}/review`).set(CSRF)).status).toBe(404);
    expect((await hod.patch(`/api/requests/${bReq._id}/approve`).set(CSRF)).status).toBe(404);
    expect((await hod.patch(`/api/requests/${bReq._id}/reject`).set(CSRF).send({ reason: 'Not allowed here' })).status).toBe(404);
    const upload = await clerk.post(`/api/requests/${bReq._id}/document`).set(CSRF).attach('document', PDF, { filename: 'x.pdf' });
    expect(upload.status).toBe(404);

    const after = await runUnscoped(() => Request.findById(bReq._id).select('+documentPath'));
    expect(after.status).toBe('UNDER_REVIEW');
    expect(after.documentPath).toBeNull();
    expect(after.statusHistory).toHaveLength(1);
    expect(await runUnscoped(() => AuditLog.countDocuments({ requestId: bReq._id }))).toBe(0);
  });

  test("request lists only contain the caller's own tenant", async () => {
    const { a, b, aReq, bReq, bDone } = await twoTenants();
    for (const user of [a.clerk, a.hod, a.admin, a.student]) {
      const agent = await loginAgent(app, user);
      const res = await agent.get('/api/requests?limit=100');
      const ids = res.body.data.items.map((r) => r._id);
      expect(ids).toEqual([String(aReq._id)]);
      expect(ids).not.toContain(String(bReq._id));
      expect(ids).not.toContain(String(bDone._id));
    }
    const bAgent = await loginAgent(app, b.clerk, 'Passw0rdTest', 'beta-college');
    const bList = await bAgent.get('/api/requests?limit=100');
    expect(bList.body.data.items.map((r) => r._id).sort()).toEqual([String(bReq._id), String(bDone._id)].sort());
  });

  test("a request id from tenant A is a 404 at tenant B, and B's own users still work normally", async () => {
    const { b, aReq } = await twoTenants();
    const bClerk = await loginAgent(app, b.clerk, 'Passw0rdTest', 'beta-college');
    expect((await bClerk.get(`/api/requests/${aReq._id}`)).status).toBe(404);
    expect((await bClerk.patch(`/api/requests/${aReq._id}/review`).set(CSRF)).status).toBe(404);
  });

  test("a student's new request and audit entry land in their own tenant", async () => {
    const { a, b } = await twoTenants();
    const agent = await loginAgent(app, a.student);
    const res = await agent.post('/api/requests').set(CSRF).send({ documentType: 'Transcript', purpose: 'Needed for a visa application' });
    expect(res.status).toBe(201);
    const stored = await runUnscoped(() => Request.findById(res.body.data.request._id));
    expect(String(stored.tenantId)).toBe(String(a.student.tenantId));
    const log = await runUnscoped(() => AuditLog.findOne({ action: 'REQUEST_SUBMITTED', requestId: stored._id }));
    expect(String(log.tenantId)).toBe(String(a.student.tenantId));
    expect(String(log.tenantId)).not.toBe(String(b.student.tenantId));
  });

  test('a client cannot choose the tenant through the body', async () => {
    const { a, b } = await twoTenants();
    const agent = await loginAgent(app, a.student);
    const res = await agent.post('/api/requests').set(CSRF).send({
      documentType: 'Transcript', purpose: 'Needed for a visa application', tenantId: String(b.student.tenantId),
    });
    expect(res.status).toBe(201);
    const stored = await runUnscoped(() => Request.findById(res.body.data.request._id));
    expect(String(stored.tenantId)).toBe(String(a.student.tenantId));
  });
});

describe('institution signup (closed by default, owner key required)', () => {
  const KEY = 'owner-signup-key-0123456789';
  const body = (over = {}) => ({
    institutionName: 'Gamma Institute', slug: 'gamma-inst', adminName: 'Gamma Admin',
    adminEmail: 'admin@gamma.example.com', adminPassword: 'GammaPass123', signupKey: KEY, ...over,
  });
  const raw = () => require('supertest')(app);
  afterEach(() => { config.signupKey = ''; });

  test('is closed when no SIGNUP_KEY is configured', async () => {
    config.signupKey = '';
    const res = await raw().post('/api/platform/signup').set(CSRF).send(body());
    expect(res.status).toBe(403);
    expect(await runUnscoped(() => Tenant.countDocuments({ slug: 'gamma-inst' }))).toBe(0);
  });

  test('rejects a wrong key and creates nothing', async () => {
    config.signupKey = KEY;
    const res = await raw().post('/api/platform/signup').set(CSRF).send(body({ signupKey: 'wrong-key-wrong-key-1' }));
    expect(res.status).toBe(403);
    expect(await runUnscoped(() => Tenant.countDocuments({ slug: 'gamma-inst' }))).toBe(0);
  });

  test('creates the institution and its first admin, who can sign in at the new address only', async () => {
    config.signupKey = KEY;
    const res = await raw().post('/api/platform/signup').set(CSRF).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data.tenant).toEqual({ name: 'Gamma Institute', slug: 'gamma-inst' });
    expect(JSON.stringify(res.body)).not.toContain('GammaPass123');

    const ok = await request(app, 'gamma-inst').post('/api/auth/login').set(CSRF).send({ email: 'admin@gamma.example.com', password: 'GammaPass123' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.role).toBe('ADMIN');
    const wrong = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'admin@gamma.example.com', password: 'GammaPass123' });
    expect(wrong.status).toBe(401);

    const tenant = await runUnscoped(() => Tenant.findOne({ slug: 'gamma-inst' }));
    const audit = await runAsTenant(tenant._id, () => AuditLog.find({ action: 'TENANT_CREATED' }));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toMatch(/GammaPass123|passwordHash/);
  });

  test('rejects a taken or reserved address and weak input', async () => {
    config.signupKey = KEY;
    expect((await raw().post('/api/platform/signup').set(CSRF).send(body())).status).toBe(201);
    expect((await raw().post('/api/platform/signup').set(CSRF).send(body({ adminEmail: 'other@gamma.example.com' }))).status).toBe(409);
    expect((await raw().post('/api/platform/signup').set(CSRF).send(body({ slug: 'platform' }))).status).toBe(400);
    expect((await raw().post('/api/platform/signup').set(CSRF).send(body({ slug: 'Bad Slug!' }))).status).toBe(400);
    expect((await raw().post('/api/platform/signup').set(CSRF).send(body({ slug: 'weak-pass', adminPassword: 'short' }))).status).toBe(400);
    expect(await runUnscoped(() => Tenant.countDocuments({ slug: 'weak-pass' }))).toBe(0);
  });

  test('needs the CSRF header like every other write', async () => {
    config.signupKey = KEY;
    expect((await raw().post('/api/platform/signup').send(body())).status).toBe(403);
  });
});

describe('SUPER_ADMIN (platform operator)', () => {
  const raw = () => require('supertest')(app);
  async function superAdmin() {
    return runUnscoped(async () => {
      const bcrypt = require('bcryptjs');
      return User.create({ name: 'Platform Owner', email: 'owner@platform.example.com', passwordHash: await bcrypt.hash('PlatformPass1', 4), role: 'SUPER_ADMIN' });
    });
  }
  async function platformAgent() {
    const agent = require('supertest').agent(app);
    const res = await agent.post('/api/platform/auth/login').set(CSRF).send({ email: 'owner@platform.example.com', password: 'PlatformPass1' });
    expect(res.status).toBe(200);
    return agent;
  }

  test('has no tenant, can sign in on the platform and list institutions (names only)', async () => {
    const su = await superAdmin();
    expect(su.tenantId).toBeNull();
    await twoTenants();
    const agent = await platformAgent();
    const res = await agent.get('/api/platform/tenants');
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((t) => t.slug).sort()).toEqual(['beta-college', 'default']);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|purpose|documentPath/);
  });

  test('the platform area requires a platform session', async () => {
    await superAdmin();
    const { a } = await twoTenants();
    expect((await raw().get('/api/platform/tenants')).status).toBe(401);
    const tenantAdmin = await loginAgent(app, a.admin);
    // A tenant admin's cookie has the wrong name/path; forging it as a platform cookie fails too.
    const token = forgeToken(a.admin._id);
    const forged = await raw().get('/api/platform/tenants').set('Cookie', `${config.cookieName}_platform=${token}`);
    expect(forged.status).toBe(401);
    expect((await tenantAdmin.get('/api/platform/tenants')).status).toBe(401);
  });

  test("a SUPER_ADMIN cannot sign in at a tenant address, and a platform token is useless there", async () => {
    await superAdmin();
    await twoTenants();
    const login = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'owner@platform.example.com', password: 'PlatformPass1' });
    expect(login.status).toBe(401);
    const jwt = require('jsonwebtoken');
    const su = await runUnscoped(() => User.findOne({ role: 'SUPER_ADMIN' }));
    const platToken = jwt.sign({ sub: String(su._id), plat: true }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).get('/api/requests').set('Cookie', `${config.cookieName}=${platToken}`);
    expect(res.status).toBe(401);
  });

  test('platform sign-in is audited, and tenant admins never see platform audit entries', async () => {
    await superAdmin();
    const { a } = await twoTenants();
    await platformAgent();
    const entries = await runUnscoped(() => AuditLog.find({ action: 'PLATFORM_LOGIN' }));
    expect(entries).toHaveLength(1);
    expect(entries[0].tenantId).toBeNull();
    const admin = await loginAgent(app, a.admin);
    const res = await admin.get('/api/admin/audit-logs?limit=100');
    expect(res.body.data.items.some((i) => i.action === 'PLATFORM_LOGIN')).toBe(false);
  });

  test('a wrong password and an unknown email look the same', async () => {
    await superAdmin();
    const x = await raw().post('/api/platform/auth/login').set(CSRF).send({ email: 'owner@platform.example.com', password: 'WrongPass123' });
    const y = await raw().post('/api/platform/auth/login').set(CSRF).send({ email: 'nobody@platform.example.com', password: 'WrongPass123' });
    expect([x.status, y.status]).toEqual([401, 401]);
    expect(x.body.message).toBe(y.body.message);
  });

  test('a tenant student cannot be turned into a SUPER_ADMIN through the platform login', async () => {
    const { a } = await twoTenants();
    const res = await raw().post('/api/platform/auth/login').set(CSRF).send({ email: a.admin.email, password: 'Passw0rdTest' });
    expect(res.status).toBe(401);
  });
});
