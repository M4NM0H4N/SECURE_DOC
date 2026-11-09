'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, request } = require('./helpers');
const AuditLog = require('../models/AuditLog');
const Request = require('../models/Request');
const { sanitize, recordSafe } = require('../services/auditService');

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

describe('sanitize (unit)', () => {
  test('removes secrets and tokens at any depth', () => {
    const out = sanitize({ ok: 1, password: 'x', nested: { token: 'y', passwordHash: 'z', keep: 'v' }, list: [{ secret: 1, a: 2 }] });
    expect(out).toEqual({ ok: 1, nested: { keep: 'v' }, list: [{ a: 2 }] });
  });

  test('recordSafe never throws, even on an invalid event', async () => {
    await expect(recordSafe({ actorId: 'not-an-id', action: 'NOT_A_REAL_ACTION' })).resolves.toBeNull();
  });
});

describe('full lifecycle produces an audit trail', () => {
  test('submit, review, approve, upload/fulfil and download are all recorded with actors', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const hod = await createUser({ role: 'HOD', department: 'CSE' });
    const admin = await createUser({ role: 'ADMIN' });
    const [s, c, h, a] = await Promise.all([student, clerk, hod, admin].map((u) => loginAgent(app, u)));

    const created = await s.post('/api/requests').set(CSRF).send({ documentType: 'Transcript', purpose: 'Applying for a masters degree' });
    const id = created.body.data.request._id;
    await c.patch(`/api/requests/${id}/review`).set(CSRF);
    await h.patch(`/api/requests/${id}/approve`).set(CSRF);
    await c.post(`/api/requests/${id}/document`).set(CSRF).attach('document', PDF, { filename: 'tr.pdf' });
    await s.get(`/api/requests/${id}/document`);

    const res = await a.get(`/api/admin/audit-logs?requestId=${id}&limit=100`);
    expect(res.status).toBe(200);
    const byAction = Object.fromEntries(res.body.data.items.map((l) => [l.action, l]));
    expect(Object.keys(byAction).sort()).toEqual(
      ['DOCUMENT_DOWNLOADED', 'DOCUMENT_UPLOADED', 'REQUEST_APPROVED', 'REQUEST_FULFILLED', 'REQUEST_REVIEWED', 'REQUEST_SUBMITTED'].sort()
    );
    expect(String(byAction.REQUEST_SUBMITTED.actorId._id)).toBe(String(student._id));
    expect(String(byAction.REQUEST_REVIEWED.actorId._id)).toBe(String(clerk._id));
    expect(String(byAction.REQUEST_APPROVED.actorId._id)).toBe(String(hod._id));
    expect(String(byAction.REQUEST_FULFILLED.actorId._id)).toBe(String(clerk._id));
    expect(byAction.REQUEST_APPROVED.details).toEqual({ previousStatus: 'UNDER_REVIEW', newStatus: 'APPROVED' });
    expect(byAction.DOCUMENT_UPLOADED.details).toMatchObject({ fileType: 'pdf' });
  });

  test('rejection is recorded', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'ME' });
    const hod = await createUser({ role: 'HOD', department: 'ME' });
    const r = await Request.create({ studentId: student._id, department: 'ME', documentType: 'Fee Receipt', purpose: 'Needed for reimbursement', status: 'UNDER_REVIEW' });
    const h = await loginAgent(app, hod);
    await h.patch(`/api/requests/${r._id}/reject`).set(CSRF).send({ reason: 'Incomplete information' });
    const log = await AuditLog.findOne({ action: 'REQUEST_REJECTED', requestId: r._id });
    expect(String(log.actorId)).toBe(String(hod._id));
    expect(log.details).toEqual({ previousStatus: 'UNDER_REVIEW', newStatus: 'REJECTED' });
  });

  test('a failed (409) transition writes no audit record', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const hod = await createUser({ role: 'HOD', department: 'CSE' });
    const r = await Request.create({ studentId: student._id, department: 'CSE', documentType: 'Transcript', purpose: 'Needed for visa process', status: 'PENDING' });
    const h = await loginAgent(app, hod);
    expect((await h.patch(`/api/requests/${r._id}/approve`).set(CSRF)).status).toBe(409);
    expect(await AuditLog.countDocuments({ requestId: r._id })).toBe(0);
  });
});

describe('user and auth events', () => {
  test('registration, login and admin user changes are recorded', async () => {
    const reg = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'New Student', email: 'new@example.com', password: 'Passw0rdX1', department: 'ECE' });
    const studentId = reg.body.data.user._id;
    await request(app).post('/api/auth/login').set(CSRF).send({ email: 'new@example.com', password: 'Passw0rdX1' });

    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const staff = await a.post('/api/admin/users').set(CSRF).send({ name: 'Clerk Z', email: 'z@example.com', password: 'Passw0rdZ1', role: 'CLERK', department: 'ECE' });
    await a.patch(`/api/admin/users/${studentId}`).set(CSRF).send({ isActive: false });
    await a.patch(`/api/admin/users/${studentId}`).set(CSRF).send({ isActive: true });
    await a.patch(`/api/admin/users/${studentId}`).set(CSRF).send({ isActive: true }); // no change -> no event

    const actions = (await AuditLog.find().lean()).map((l) => l.action);
    for (const expected of ['USER_REGISTERED', 'USER_LOGIN', 'USER_CREATED_BY_ADMIN', 'USER_DEACTIVATED', 'USER_ACTIVATED']) {
      expect(actions).toContain(expected);
    }
    expect(actions.filter((x) => x === 'USER_ACTIVATED')).toHaveLength(1);
    const created = await AuditLog.findOne({ action: 'USER_CREATED_BY_ADMIN' });
    expect(created.details).toMatchObject({ userId: staff.body.data.user._id, role: 'CLERK', department: 'ECE' });
  });

  test('SECURITY: no password, hash or token ever appears in the audit trail', async () => {
    await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Secret S', email: 's@example.com', password: 'Sup3rSecretPass', department: 'CSE' });
    await request(app).post('/api/auth/login').set(CSRF).send({ email: 's@example.com', password: 'Sup3rSecretPass' });
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    await a.post('/api/admin/users').set(CSRF).send({ name: 'C', email: 'c@example.com', password: 'AnotherSecret9', role: 'HOD', department: 'CSE' });
    const dump = JSON.stringify(await AuditLog.find().lean());
    expect(dump).not.toMatch(/Sup3rSecretPass|AnotherSecret9|passwordHash|\$2[aby]\$|sdw_token|eyJ/);
  });

  test('failed login is not recorded as a login', async () => {
    await createUser({ role: 'STUDENT', email: 'x@example.com' });
    await request(app).post('/api/auth/login').set(CSRF).send({ email: 'x@example.com', password: 'WrongPass1' });
    expect(await AuditLog.countDocuments({ action: 'USER_LOGIN' })).toBe(0);
  });
});

describe('GET /api/admin/audit-logs access and filters', () => {
  test.each(['STUDENT', 'CLERK', 'HOD'])('SECURITY: %s cannot read audit logs (403)', async (role) => {
    const u = await createUser({ role });
    const agent = await loginAgent(app, u);
    expect((await agent.get('/api/admin/audit-logs')).status).toBe(403);
  });

  test('unauthenticated -> 401', async () => {
    expect((await request(app).get('/api/admin/audit-logs')).status).toBe(401);
  });

  test('admin can filter by action and paginate; invalid filters -> 400', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const s = await loginAgent(app, student);
    for (let i = 0; i < 3; i += 1) {
      await s.post('/api/requests').set(CSRF).send({ documentType: 'Other', purpose: `Purpose number ${i} for audit paging` });
    }
    const a = await loginAgent(app, admin);
    const filtered = await a.get('/api/admin/audit-logs?action=REQUEST_SUBMITTED&limit=2&page=1');
    expect(filtered.body.data.total).toBe(3);
    expect(filtered.body.data.items).toHaveLength(2);
    expect((await a.get('/api/admin/audit-logs?action=HACK')).status).toBe(400);
    expect((await a.get('/api/admin/audit-logs?requestId=nope')).status).toBe(400);
    expect((await a.get('/api/admin/audit-logs?limit=5000')).status).toBe(400);
    expect((await a.get('/api/admin/audit-logs?action[$ne]=x')).status).toBe(400);
  });
});

describe('append-only behaviour', () => {
  test('SECURITY: there is no create/update/delete API for audit records', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const log = await AuditLog.create({ actorId: admin._id, action: 'USER_LOGIN' });
    const before = await AuditLog.countDocuments();
    for (const [method, url] of [['post', '/api/admin/audit-logs'], ['patch', `/api/admin/audit-logs/${log._id}`], ['put', `/api/admin/audit-logs/${log._id}`], ['delete', `/api/admin/audit-logs/${log._id}`], ['delete', '/api/admin/audit-logs']]) {
      const res = await a[method](url).set(CSRF).send({});
      expect([404, 405]).toContain(res.status);
    }
    expect(await AuditLog.countDocuments()).toBe(before);
    expect(await AuditLog.findById(log._id)).not.toBeNull();
  });

  test('the model itself refuses updates and deletes (application-level only)', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const log = await AuditLog.create({ actorId: admin._id, action: 'USER_LOGIN' });
    await expect(AuditLog.updateOne({ _id: log._id }, { action: 'USER_ACTIVATED' })).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(AuditLog.findOneAndDelete({ _id: log._id })).rejects.toThrow(/append-only/);
    log.action = 'USER_ACTIVATED';
    await expect(log.save()).rejects.toThrow(/append-only/);
    expect((await AuditLog.findById(log._id)).action).toBe('USER_LOGIN');
  });
});
