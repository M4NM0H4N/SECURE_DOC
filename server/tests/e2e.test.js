'use strict';

// Automated version of the final demonstration (blueprint section 24),
// including the security verification step. Uses only the public HTTP API.
process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, request, addStaff } = require('./helpers');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\nOfficial Bonafide Certificate\n');

let app;
const ctx = {};

beforeAll(async () => {
  await startDb();
  await clearDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);

const login = async (email, password) => {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email, password });
  expect(res.status).toBe(200);
  return agent;
};

describe('Step 0: setup (seed admin, admin creates staff, students self-register)', () => {
  test('admin exists (as created by signup) and invites a Clerk and HODs, who accept', async () => {
    ctx.admin = await createUser({ role: 'ADMIN', email: 'admin@example.com', password: 'AdminPass123' });
    ctx.adminAgent = await login('admin@example.com', 'AdminPass123');

    const mk = (name, email, role, department) => addStaff(app, ctx.adminAgent, { name, email, role, department });
    expect((await mk('Clerk CSE', 'clerk@example.com', 'CLERK', 'CSE')).status).toBe(201);
    expect((await mk('HOD CSE', 'hod@example.com', 'HOD', 'CSE')).status).toBe(201);
    expect((await mk('HOD ME', 'hod.me@example.com', 'HOD', 'ME')).status).toBe(201);
    expect((await mk('Clerk ME', 'clerk.me@example.com', 'CLERK', 'ME')).status).toBe(201);
  });

  test('two students register publicly (always as STUDENT)', async () => {
    for (const [key, name, email] of [['A', 'Student A', 'a@example.com'], ['B', 'Student B', 'b@example.com']]) {
      const res = await request(app).post('/api/auth/register').set(CSRF).send({ name, email, password: 'StudentPass1', department: 'CSE', role: 'ADMIN' });
      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe('STUDENT');
      ctx[`student${key}`] = res.body.data.user;
    }
  });
});

describe('Steps 1-6: the complete workflow', () => {
  test('Step 1 - Student A submits a Bonafide Certificate request (PENDING)', async () => {
    ctx.a = await login('a@example.com', 'StudentPass1');
    const res = await ctx.a.post('/api/requests').set(CSRF).send({ documentType: 'Bonafide Certificate', purpose: 'Required for education loan application' });
    expect(res.status).toBe(201);
    expect(res.body.data.request.status).toBe('PENDING');
    ctx.requestId = res.body.data.request._id;
  });

  test('Step 2 - Clerk sees it in the pending queue and moves it to UNDER_REVIEW', async () => {
    ctx.clerk = await login('clerk@example.com', 'StaffPass123');
    const queue = await ctx.clerk.get('/api/requests?status=PENDING');
    expect(queue.body.data.items.map((r) => r._id)).toContain(ctx.requestId);
    const res = await ctx.clerk.patch(`/api/requests/${ctx.requestId}/review`).set(CSRF);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('UNDER_REVIEW');
  });

  test('Step 3 - HOD of the department approves it', async () => {
    ctx.hod = await login('hod@example.com', 'StaffPass123');
    const queue = await ctx.hod.get('/api/requests?status=UNDER_REVIEW');
    expect(queue.body.data.items.map((r) => r._id)).toContain(ctx.requestId);
    const res = await ctx.hod.patch(`/api/requests/${ctx.requestId}/approve`).set(CSRF);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('APPROVED');
  });

  test('Step 4 - Clerk uploads the official document; request becomes FULFILLED', async () => {
    const approved = await ctx.clerk.get('/api/requests?status=APPROVED');
    expect(approved.body.data.items.map((r) => r._id)).toContain(ctx.requestId);
    const res = await ctx.clerk.post(`/api/requests/${ctx.requestId}/document`).set(CSRF).attach('document', PDF, { filename: 'bonafide.pdf' });
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('FULFILLED');
  });

  test('Step 5 - Student A sees FULFILLED with full history and downloads the document', async () => {
    const detail = await ctx.a.get(`/api/requests/${ctx.requestId}`);
    expect(detail.body.data.request.status).toBe('FULFILLED');
    expect(detail.body.data.request.statusHistory.map((h) => h.to)).toEqual(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'FULFILLED']);
    const dl = await ctx.a.get(`/api/requests/${ctx.requestId}/document`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.body.equals(PDF)).toBe(true);
  });

  test('Step 6 - Admin sees users and the complete audit trail for the request', async () => {
    const users = await ctx.adminAgent.get('/api/admin/users?limit=100');
    expect(users.body.data.total).toBe(7);
    const logs = await ctx.adminAgent.get(`/api/admin/audit-logs?requestId=${ctx.requestId}&limit=100`);
    const ordered = logs.body.data.items.slice().reverse().map((l) => l.action);
    expect(ordered).toEqual(['REQUEST_SUBMITTED', 'REQUEST_REVIEWED', 'REQUEST_APPROVED', 'DOCUMENT_UPLOADED', 'REQUEST_FULFILLED', 'DOCUMENT_DOWNLOADED']);
    const actors = logs.body.data.items.map((l) => l.actorId.role);
    expect(new Set(actors)).toEqual(new Set(['STUDENT', 'CLERK', 'HOD']));
  });
});

describe('Step 7: security verification on the same request', () => {
  test("Student B cannot see or download Student A's request", async () => {
    const b = await login('b@example.com', 'StudentPass1');
    expect((await b.get(`/api/requests/${ctx.requestId}`)).status).toBe(404);
    expect((await b.get(`/api/requests/${ctx.requestId}/document`)).status).toBe(404);
    expect((await b.get('/api/requests')).body.data.total).toBe(0);
  });

  test('a Student cannot approve, reject or review', async () => {
    for (const action of ['review', 'approve']) {
      expect((await ctx.a.patch(`/api/requests/${ctx.requestId}/${action}`).set(CSRF)).status).toBe(403);
    }
    expect((await ctx.a.patch(`/api/requests/${ctx.requestId}/reject`).set(CSRF).send({ reason: 'trying to reject' })).status).toBe(403);
  });

  test('a Clerk cannot approve or reject', async () => {
    expect((await ctx.clerk.patch(`/api/requests/${ctx.requestId}/approve`).set(CSRF)).status).toBe(403);
    expect((await ctx.clerk.patch(`/api/requests/${ctx.requestId}/reject`).set(CSRF).send({ reason: 'clerk rejecting' })).status).toBe(403);
  });

  test("an HOD of another department cannot access or act on it", async () => {
    const hodMe = await login('hod.me@example.com', 'StaffPass123');
    expect((await hodMe.get(`/api/requests/${ctx.requestId}`)).status).toBe(404);
    expect((await hodMe.patch(`/api/requests/${ctx.requestId}/approve`).set(CSRF)).status).toBe(404);
    expect((await hodMe.get(`/api/requests/${ctx.requestId}/document`)).status).toBe(404);
    expect((await hodMe.get('/api/requests')).body.data.total).toBe(0);
  });

  test('an HOD cannot upload a fulfilment document', async () => {
    const res = await ctx.hod.post(`/api/requests/${ctx.requestId}/document`).set(CSRF).attach('document', PDF, { filename: 'x.pdf' });
    expect(res.status).toBe(403);
  });

  test('invalid status transitions are rejected', async () => {
    expect((await ctx.hod.patch(`/api/requests/${ctx.requestId}/approve`).set(CSRF)).status).toBe(409);
    expect((await ctx.hod.patch(`/api/requests/${ctx.requestId}/reject`).set(CSRF).send({ reason: 'too late to reject' })).status).toBe(409);
    expect((await ctx.clerk.patch(`/api/requests/${ctx.requestId}/review`).set(CSRF)).status).toBe(409);
    const again = await ctx.clerk.post(`/api/requests/${ctx.requestId}/document`).set(CSRF).attach('document', PDF, { filename: 'again.pdf' });
    expect(again.status).toBe(409);
  });

  test('unauthorized document downloads are blocked (anonymous, admin, other student)', async () => {
    expect((await request(app).get(`/api/requests/${ctx.requestId}/document`)).status).toBe(401);
    expect((await ctx.adminAgent.get(`/api/requests/${ctx.requestId}/document`)).status).toBe(403);
  });

  test('the admin cannot approve or upload (no workflow bypass)', async () => {
    expect((await ctx.adminAgent.patch(`/api/requests/${ctx.requestId}/approve`).set(CSRF)).status).toBe(403);
    expect((await ctx.adminAgent.post(`/api/requests/${ctx.requestId}/document`).set(CSRF).attach('document', PDF, { filename: 'x.pdf' })).status).toBe(403);
  });

  test('deactivating a student locks them out immediately, even with a valid session', async () => {
    expect((await ctx.a.get('/api/auth/me')).status).toBe(200);
    const off = await ctx.adminAgent.patch(`/api/admin/users/${ctx.studentA._id}`).set(CSRF).send({ isActive: false });
    expect(off.status).toBe(200);
    expect((await ctx.a.get('/api/auth/me')).status).toBe(403);
    expect((await ctx.a.get(`/api/requests/${ctx.requestId}/document`)).status).toBe(403);
  });
});
