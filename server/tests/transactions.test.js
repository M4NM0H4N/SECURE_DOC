'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent } = require('./helpers');
const Request = require('../models/Request');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const auditService = require('../services/auditService');
const tx = require('../config/transactions');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  tx.resetMode();
  await clearDb();
});
afterEach(() => {
  jest.restoreAllMocks();
  tx.resetMode();
});

describe('transaction mode (replica set)', () => {
  test('the test database is a replica set, so transactions are really in use', async () => {
    expect(await tx.detectMode()).toBe('replica');
  });

  test('ROLLBACK: audit failure during review leaves the request untouched', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const r = await createRequest(student);
    const agent = await loginAgent(app, clerk);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));

    const res = await agent.patch(`/api/requests/${r._id}/review`).set(CSRF);
    expect(res.status).toBe(500);
    const after = await Request.findById(r._id);
    expect(after.status).toBe('PENDING');
    expect(after.reviewedBy).toBeNull();
    expect(after.statusHistory).toHaveLength(1);
    expect(await AuditLog.countDocuments({ requestId: r._id })).toBe(0);
  });

  test('ROLLBACK: audit failure while submitting a request creates no request', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const agent = await loginAgent(app, student);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await agent.post('/api/requests').set(CSRF).send({ documentType: 'Transcript', purpose: 'Needed for transfer process' });
    expect(res.status).toBe(500);
    expect(await Request.countDocuments()).toBe(0);
  });

  test('ROLLBACK: audit failure while creating staff creates no user', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await agent.post('/api/admin/users').set(CSRF).send({ name: 'Ghost Clerk', email: 'ghost@example.com', password: 'Passw0rdG1', role: 'CLERK', department: 'CSE' });
    expect(res.status).toBe(500);
    expect(await User.countDocuments({ email: 'ghost@example.com' })).toBe(0);
  });

  test('ROLLBACK: audit failure while deactivating a user keeps the user active', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, admin);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await agent.patch(`/api/admin/users/${student._id}`).set(CSRF).send({ isActive: false });
    expect(res.status).toBe(500);
    expect((await User.findById(student._id)).isActive).toBe(true);
  });

  test('COMMIT: a successful transition stores the status change and its audit record together', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const r = await createRequest(student);
    const agent = await loginAgent(app, clerk);
    expect((await agent.patch(`/api/requests/${r._id}/review`).set(CSRF)).status).toBe(200);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
    expect(await AuditLog.countDocuments({ requestId: r._id, action: 'REQUEST_REVIEWED' })).toBe(1);
  });
});

describe('standalone fallback (documented limitation)', () => {
  test('without transactions the status check is still atomic (conditional update)', async () => {
    tx.setModeForTests('standalone');
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const hod1 = await createUser({ role: 'HOD', department: 'CSE' });
    const hod2 = await createUser({ role: 'HOD', department: 'CSE' });
    const r = await createRequest(student, { status: 'UNDER_REVIEW' });
    const [a1, a2] = [await loginAgent(app, hod1), await loginAgent(app, hod2)];
    const results = await Promise.all([a1.patch(`/api/requests/${r._id}/approve`).set(CSRF), a2.patch(`/api/requests/${r._id}/approve`).set(CSRF)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
  });

  test('KNOWN LIMITATION: without transactions an audit failure is NOT rolled back, but the error is still reported', async () => {
    tx.setModeForTests('standalone');
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const r = await createRequest(student);
    const agent = await loginAgent(app, clerk);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await agent.patch(`/api/requests/${r._id}/review`).set(CSRF);
    // Never presented as success...
    expect(res.status).toBe(500);
    // ...but the status write already happened and has no audit record. This is
    // the non-atomic gap that a replica set closes. See docs/TRANSACTIONS.md.
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
    expect(await AuditLog.countDocuments({ requestId: r._id })).toBe(0);
  });
});
