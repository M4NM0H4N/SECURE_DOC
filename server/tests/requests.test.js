'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, request } = require('./helpers');
const Request = require('../models/Request');
const { scopeFilter } = require('../services/requestService');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

const validBody = { documentType: 'Bonafide Certificate', purpose: 'Required for bank education loan' };

describe('scopeFilter (unit)', () => {
  test('student -> own id, staff -> department, admin -> everything', () => {
    expect(scopeFilter({ role: 'STUDENT', _id: 'a' })).toEqual({ studentId: 'a' });
    expect(scopeFilter({ role: 'CLERK', department: 'ECE' })).toEqual({ department: 'ECE' });
    expect(scopeFilter({ role: 'HOD', department: 'ME' })).toEqual({ department: 'ME' });
    expect(scopeFilter({ role: 'ADMIN' })).toEqual({});
  });

  test('staff without a department are denied', () => {
    expect(() => scopeFilter({ role: 'CLERK', department: null })).toThrow();
  });
});

describe('POST /api/requests', () => {
  test('student submits a request; starts PENDING with department from profile', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'ECE' });
    const agent = await loginAgent(app, student);
    const res = await agent.post('/api/requests').set(CSRF).send(validBody);
    expect(res.status).toBe(201);
    const r = res.body.data.request;
    expect(r.status).toBe('PENDING');
    expect(r.department).toBe('ECE');
    expect(String(r.studentId)).toBe(String(student._id));
    expect(r.statusHistory).toHaveLength(1);
    expect(r.statusHistory[0]).toMatchObject({ from: null, to: 'PENDING' });
  });

  test('SECURITY: client cannot set department, status, studentId or decision fields', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const other = await createUser({ role: 'STUDENT', department: 'ME' });
    const agent = await loginAgent(app, student);
    const res = await agent.post('/api/requests').set(CSRF).send({
      ...validBody,
      department: 'ME',
      status: 'APPROVED',
      studentId: String(other._id),
      decidedBy: String(other._id),
      documentPath: 'x.pdf',
    });
    expect(res.status).toBe(201);
    const stored = await Request.findById(res.body.data.request._id).select('+documentPath');
    expect(stored.department).toBe('CSE');
    expect(stored.status).toBe('PENDING');
    expect(String(stored.studentId)).toBe(String(student._id));
    expect(stored.decidedBy).toBeNull();
    expect(stored.documentPath).toBeNull();
  });

  test.each([
    ['unsupported document type', { documentType: 'Passport' }],
    ['missing document type', { documentType: undefined }],
    ['purpose too short', { purpose: 'short' }],
    ['purpose too long', { purpose: 'x'.repeat(501) }],
    ['missing purpose', { purpose: undefined }],
    ['operator object as documentType', { documentType: { $ne: '' } }],
    ['array as purpose', { purpose: ['long enough purpose text'] }],
  ])('validation: %s -> 400', async (_label, override) => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    const res = await agent.post('/api/requests').set(CSRF).send({ ...validBody, ...override });
    expect(res.status).toBe(400);
    expect(await Request.countDocuments()).toBe(0);
  });

  test.each(['CLERK', 'HOD', 'ADMIN'])('SECURITY: %s cannot submit requests (403)', async (role) => {
    const user = await createUser({ role });
    const agent = await loginAgent(app, user);
    expect((await agent.post('/api/requests').set(CSRF).send(validBody)).status).toBe(403);
  });

  test('unauthenticated -> 401; missing CSRF header -> 403', async () => {
    expect((await request(app).post('/api/requests').set(CSRF).send(validBody)).status).toBe(401);
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    expect((await agent.post('/api/requests').send(validBody)).status).toBe(403);
  });

  test('purpose is trimmed and HTML is stored as plain text (not interpreted)', async () => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    const res = await agent.post('/api/requests').set(CSRF).send({ ...validBody, purpose: '  <b>bold</b> purpose text  ' });
    expect(res.body.data.request.purpose).toBe('<b>bold</b> purpose text');
  });
});

describe('GET /api/requests (listing and scope)', () => {
  test('student sees only their own requests', async () => {
    const a = await createUser({ role: 'STUDENT', department: 'CSE' });
    const b = await createUser({ role: 'STUDENT', department: 'CSE' });
    await createRequest(a);
    await createRequest(a, { documentType: 'Transcript' });
    await createRequest(b);
    const agent = await loginAgent(app, a);
    const res = await agent.get('/api/requests');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.every((r) => String(r.studentId._id) === String(a._id))).toBe(true);
  });

  test('SECURITY: clerk and HOD see only their department', async () => {
    const cse = await createUser({ role: 'STUDENT', department: 'CSE' });
    const me = await createUser({ role: 'STUDENT', department: 'ME' });
    await createRequest(cse);
    await createRequest(me);
    for (const role of ['CLERK', 'HOD']) {
      const staff = await createUser({ role, department: 'CSE' });
      const agent = await loginAgent(app, staff);
      const res = await agent.get('/api/requests');
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].department).toBe('CSE');
    }
  });

  test('admin sees requests across all departments', async () => {
    await createRequest(await createUser({ role: 'STUDENT', department: 'CSE' }));
    await createRequest(await createUser({ role: 'STUDENT', department: 'ME' }));
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    expect((await agent.get('/api/requests')).body.data.total).toBe(2);
  });

  test('status filter works; invalid status and oversize limit are rejected', async () => {
    const s = await createUser({ role: 'STUDENT' });
    await createRequest(s);
    await createRequest(s, { status: 'APPROVED' });
    const agent = await loginAgent(app, s);
    expect((await agent.get('/api/requests?status=APPROVED')).body.data.total).toBe(1);
    expect((await agent.get('/api/requests?status=HACKED')).status).toBe(400);
    expect((await agent.get('/api/requests?limit=1000')).status).toBe(400);
    expect((await agent.get('/api/requests?status[$ne]=PENDING')).status).toBe(400);
  });

  test('pagination returns the requested page size, newest first', async () => {
    const s = await createUser({ role: 'STUDENT' });
    for (let i = 0; i < 3; i += 1) await createRequest(s, { purpose: `Purpose number ${i} for testing` });
    const agent = await loginAgent(app, s);
    const res = await agent.get('/api/requests?limit=2&page=1');
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items[0].purpose).toMatch(/number 2/);
  });

  test('empty list is a valid result', async () => {
    const s = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, s);
    const res = await agent.get('/api/requests');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('unauthenticated -> 401', async () => {
    expect((await request(app).get('/api/requests')).status).toBe(401);
  });
});

describe('GET /api/requests/:id (ownership and department)', () => {
  test('student can open their own request with history', async () => {
    const s = await createUser({ role: 'STUDENT' });
    const r = await createRequest(s);
    const agent = await loginAgent(app, s);
    const res = await agent.get(`/api/requests/${r._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.request.documentType).toBe('Bonafide Certificate');
    expect(res.body.data.request.statusHistory).toHaveLength(1);
    expect(res.body.data.request.statusHistory[0].by.name).toBeDefined();
  });

  test("SECURITY: student cannot read another student's request (404)", async () => {
    const a = await createUser({ role: 'STUDENT', department: 'CSE' });
    const b = await createUser({ role: 'STUDENT', department: 'CSE' });
    const r = await createRequest(a);
    const agent = await loginAgent(app, b);
    expect((await agent.get(`/api/requests/${r._id}`)).status).toBe(404);
  });

  test('SECURITY: same-department student still cannot read it, other-department staff cannot either', async () => {
    const a = await createUser({ role: 'STUDENT', department: 'CSE' });
    const r = await createRequest(a);
    for (const role of ['CLERK', 'HOD']) {
      const wrongDept = await createUser({ role, department: 'EEE' });
      const agent = await loginAgent(app, wrongDept);
      expect((await agent.get(`/api/requests/${r._id}`)).status).toBe(404);
    }
  });

  test('clerk, HOD of the same department and admin can read it', async () => {
    const a = await createUser({ role: 'STUDENT', department: 'CIVIL' });
    const r = await createRequest(a);
    for (const [role, dept] of [['CLERK', 'CIVIL'], ['HOD', 'CIVIL'], ['ADMIN', null]]) {
      const u = await createUser({ role, department: dept || undefined });
      const agent = await loginAgent(app, u);
      const res = await agent.get(`/api/requests/${r._id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.request.studentId.name).toBeDefined();
    }
  });

  test('invalid id -> 400, unknown id -> 404', async () => {
    const s = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, s);
    expect((await agent.get('/api/requests/not-an-id')).status).toBe(400);
    expect((await agent.get('/api/requests/64b7f0f0f0f0f0f0f0f0f0f0')).status).toBe(404);
  });

  test('SECURITY: storage path is never exposed', async () => {
    const s = await createUser({ role: 'STUDENT' });
    const r = await createRequest(s, { status: 'FULFILLED', documentPath: 'secret-uuid.pdf' });
    const agent = await loginAgent(app, s);
    const res = await agent.get(`/api/requests/${r._id}`);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-uuid|documentPath/);
    const list = await agent.get('/api/requests');
    expect(JSON.stringify(list.body)).not.toMatch(/secret-uuid|documentPath/);
  });

  test('SECURITY: deactivated student cannot read their own request', async () => {
    const s = await createUser({ role: 'STUDENT' });
    const r = await createRequest(s);
    const agent = await loginAgent(app, s);
    await require('../models/User').updateOne({ _id: s._id }, { isActive: false });
    expect((await agent.get(`/api/requests/${r._id}`)).status).toBe(403);
  });
});
