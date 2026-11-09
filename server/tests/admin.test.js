'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, request } = require('./helpers');
const User = require('../models/User');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

const staff = { name: 'Clerk One', email: 'clerk1@example.com', password: 'Passw0rdOK', role: 'CLERK', department: 'ECE' };

describe('admin user management', () => {
  test('admin creates CLERK and HOD accounts with departments', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    const c = await agent.post('/api/admin/users').set(CSRF).send(staff);
    expect(c.status).toBe(201);
    expect(c.body.data.user.role).toBe('CLERK');
    expect(c.body.data.user.department).toBe('ECE');
    const h = await agent.post('/api/admin/users').set(CSRF).send({ ...staff, email: 'hod1@example.com', role: 'HOD' });
    expect(h.status).toBe(201);
    expect(JSON.stringify(h.body)).not.toMatch(/passwordHash/);
  });

  test('SECURITY: admin cannot create ADMIN or STUDENT through the staff endpoint', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    const a = await agent.post('/api/admin/users').set(CSRF).send({ ...staff, role: 'ADMIN' });
    const s = await agent.post('/api/admin/users').set(CSRF).send({ ...staff, email: 'x@example.com', role: 'STUDENT' });
    expect(a.status).toBe(400);
    expect(s.status).toBe(400);
  });

  test('staff creation requires a valid department', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    const res = await agent.post('/api/admin/users').set(CSRF).send({ ...staff, department: undefined });
    expect(res.status).toBe(400);
  });

  test('admin lists users with pagination and role filter', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    await createUser({ role: 'STUDENT' });
    await createUser({ role: 'CLERK' });
    const agent = await loginAgent(app, admin);
    const all = await agent.get('/api/admin/users');
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(3);
    const clerks = await agent.get('/api/admin/users?role=CLERK');
    expect(clerks.body.data.items).toHaveLength(1);
    expect((await agent.get('/api/admin/users?limit=9999')).status).toBe(400);
  });

  test('admin can deactivate and reactivate a user; deactivated user is locked out', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const student = await createUser({ role: 'STUDENT', email: 'target@example.com' });
    const adminAgent = await loginAgent(app, admin);
    const studentAgent = await loginAgent(app, student);

    const off = await adminAgent.patch(`/api/admin/users/${student._id}`).set(CSRF).send({ isActive: false });
    expect(off.status).toBe(200);
    expect((await studentAgent.get('/api/auth/me')).status).toBe(403);

    await adminAgent.patch(`/api/admin/users/${student._id}`).set(CSRF).send({ isActive: true });
    expect((await studentAgent.get('/api/auth/me')).status).toBe(200);
  });

  test('SECURITY: role cannot be changed through PATCH', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, admin);
    const res = await agent.patch(`/api/admin/users/${student._id}`).set(CSRF).send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect((await User.findById(student._id)).role).toBe('STUDENT');
  });

  test('admin cannot deactivate their own account', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    const res = await agent.patch(`/api/admin/users/${admin._id}`).set(CSRF).send({ isActive: false });
    expect(res.status).toBe(400);
  });

  test('invalid user id -> 400, unknown id -> 404', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    expect((await agent.patch('/api/admin/users/abc').set(CSRF).send({ isActive: true })).status).toBe(400);
    expect((await agent.patch('/api/admin/users/64b7f0f0f0f0f0f0f0f0f0f0').set(CSRF).send({ isActive: true })).status).toBe(404);
  });
});

describe('admin endpoints are RBAC protected', () => {
  test.each(['STUDENT', 'CLERK', 'HOD'])('SECURITY: %s gets 403 on admin routes', async (role) => {
    const user = await createUser({ role });
    const agent = await loginAgent(app, user);
    expect((await agent.get('/api/admin/users')).status).toBe(403);
    expect((await agent.post('/api/admin/users').set(CSRF).send(staff)).status).toBe(403);
    expect((await agent.patch(`/api/admin/users/${user._id}`).set(CSRF).send({ isActive: false })).status).toBe(403);
  });

  test('unauthenticated -> 401', async () => {
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
  });
});

describe('rate limiting', () => {
  test('login is rate limited', async () => {
    const limited = makeApp({ authRateLimitMax: 3 });
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await request(limited).post('/api/auth/login').set(CSRF).send({ email: 'a@b.com', password: 'x' });
    }
    expect(last.status).toBe(429);
  });
});
