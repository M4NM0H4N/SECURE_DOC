'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent } = require('./helpers');
const Request = require('../models/Request');
const User = require('../models/User');
const { buildRules, candidates } = require('../services/workflowEngine');
const { DEFAULT_WORKFLOW_STEPS } = require('../config/constants');

// The MVP's fixed TRANSITIONS table is now derived from the default workflow definition.
const DEFAULT_RULES = buildRules({ steps: DEFAULT_WORKFLOW_STEPS }).filter((r) => r.kind !== 'needs_info');
const findRule = (to, role) => candidates(DEFAULT_RULES, to, role)[0] || null;

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

// Builds a student plus a clerk and HOD of the same department, with logged-in agents.
async function setup(dept = 'CSE', status = 'PENDING') {
  const student = await createUser({ role: 'STUDENT', department: dept });
  const clerk = await createUser({ role: 'CLERK', department: dept });
  const hod = await createUser({ role: 'HOD', department: dept });
  const r = await createRequest(student, { status });
  return {
    student, clerk, hod, r,
    studentAgent: await loginAgent(app, student),
    clerkAgent: await loginAgent(app, clerk),
    hodAgent: await loginAgent(app, hod),
  };
}

const act = (agent, id, action, body) => agent.patch(`/api/requests/${id}/${action}`).set(CSRF).send(body || {});

describe('transition rules (unit)', () => {
  test('exactly the four permitted transitions exist', () => {
    expect(DEFAULT_RULES.map((t) => `${t.from}>${t.to}:${t.role}`).sort()).toEqual([
      'APPROVED>FULFILLED:CLERK',
      'PENDING>UNDER_REVIEW:CLERK',
      'UNDER_REVIEW>APPROVED:HOD',
      'UNDER_REVIEW>REJECTED:HOD',
    ]);
  });

  test('findRule matches target and role only', () => {
    expect(findRule('UNDER_REVIEW', 'CLERK').from).toBe('PENDING');
    expect(findRule('UNDER_REVIEW', 'HOD')).toBeNull();
    expect(findRule('APPROVED', 'CLERK')).toBeNull();
    expect(findRule('PENDING', 'CLERK')).toBeNull();
  });
});

describe('happy path', () => {
  test('PENDING -> UNDER_REVIEW -> APPROVED with actors and history recorded', async () => {
    const { r, clerk, hod, clerkAgent, hodAgent, studentAgent } = await setup();

    const review = await act(clerkAgent, r._id, 'review');
    expect(review.status).toBe(200);
    expect(review.body.data.request.status).toBe('UNDER_REVIEW');
    expect(String(review.body.data.request.reviewedBy)).toBe(String(clerk._id));
    expect(review.body.data.request.decidedBy).toBeNull();

    const approve = await act(hodAgent, r._id, 'approve');
    expect(approve.status).toBe(200);
    expect(approve.body.data.request.status).toBe('APPROVED');
    expect(String(approve.body.data.request.decidedBy)).toBe(String(hod._id));

    const detail = await studentAgent.get(`/api/requests/${r._id}`);
    expect(detail.body.data.request.status).toBe('APPROVED');
    expect(detail.body.data.request.statusHistory.map((h) => h.to)).toEqual(['PENDING', 'UNDER_REVIEW', 'APPROVED']);
    expect(detail.body.data.request.statusHistory[1].from).toBe('PENDING');
  });

  test('HOD rejects with a reason; student can see it', async () => {
    const { r, hodAgent, studentAgent } = await setup('ME', 'UNDER_REVIEW');
    const res = await act(hodAgent, r._id, 'reject', { reason: '  Fees are pending for this semester  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('REJECTED');
    expect(res.body.data.request.rejectionReason).toBe('Fees are pending for this semester');
    const seen = await studentAgent.get(`/api/requests/${r._id}`);
    expect(seen.body.data.request.rejectionReason).toMatch(/Fees are pending/);
  });
});

describe('rejection reason is mandatory', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '      '],
    ['too short', 'no'],
    ['too long', 'x'.repeat(501)],
    ['object', { $ne: '' }],
    ['array', ['a valid sized reason']],
  ])('reason %s -> 400 and status unchanged', async (_l, reason) => {
    const { r, hodAgent } = await setup('CSE', 'UNDER_REVIEW');
    const res = await act(hodAgent, r._id, 'reject', { reason });
    expect(res.status).toBe(400);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
  });
});

describe('RBAC on workflow endpoints', () => {
  test('SECURITY: student cannot review, approve or reject', async () => {
    const { r, studentAgent } = await setup('CSE', 'UNDER_REVIEW');
    for (const a of ['review', 'approve']) expect((await act(studentAgent, r._id, a)).status).toBe(403);
    expect((await act(studentAgent, r._id, 'reject', { reason: 'not allowed here' })).status).toBe(403);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
  });

  test('SECURITY: clerk cannot approve or reject', async () => {
    const { r, clerkAgent } = await setup('CSE', 'UNDER_REVIEW');
    expect((await act(clerkAgent, r._id, 'approve')).status).toBe(403);
    expect((await act(clerkAgent, r._id, 'reject', { reason: 'clerk may not reject' })).status).toBe(403);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
  });

  test('SECURITY: HOD cannot do the clerk review step', async () => {
    const { r, hodAgent } = await setup('CSE', 'PENDING');
    expect((await act(hodAgent, r._id, 'review')).status).toBe(403);
    expect((await Request.findById(r._id)).status).toBe('PENDING');
  });

  test('SECURITY: admin cannot bypass the workflow', async () => {
    const { r } = await setup('CSE', 'UNDER_REVIEW');
    const admin = await createUser({ role: 'ADMIN' });
    const adminAgent = await loginAgent(app, admin);
    for (const a of ['review', 'approve']) expect((await act(adminAgent, r._id, a)).status).toBe(403);
    expect((await act(adminAgent, r._id, 'reject', { reason: 'admin has no power' })).status).toBe(403);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
  });

  test('SECURITY: inactive staff are blocked even with a valid token', async () => {
    const { r, clerk, clerkAgent } = await setup();
    await User.updateOne({ _id: clerk._id }, { isActive: false });
    expect((await act(clerkAgent, r._id, 'review')).status).toBe(403);
    expect((await Request.findById(r._id)).status).toBe('PENDING');
  });

  test('missing CSRF header is rejected', async () => {
    const { r, clerkAgent } = await setup();
    expect((await clerkAgent.patch(`/api/requests/${r._id}/review`)).status).toBe(403);
  });
});

describe('department boundaries', () => {
  test('SECURITY: clerk of another department gets 404 and nothing changes', async () => {
    const { r } = await setup('CSE', 'PENDING');
    const otherClerk = await createUser({ role: 'CLERK', department: 'EEE' });
    const agent = await loginAgent(app, otherClerk);
    expect((await act(agent, r._id, 'review')).status).toBe(404);
    expect((await Request.findById(r._id)).status).toBe('PENDING');
  });

  test('SECURITY: HOD of another department cannot approve or reject (404)', async () => {
    const { r } = await setup('CSE', 'UNDER_REVIEW');
    const otherHod = await createUser({ role: 'HOD', department: 'CIVIL' });
    const agent = await loginAgent(app, otherHod);
    expect((await act(agent, r._id, 'approve')).status).toBe(404);
    expect((await act(agent, r._id, 'reject', { reason: 'wrong department attempt' })).status).toBe(404);
    expect((await Request.findById(r._id)).status).toBe('UNDER_REVIEW');
  });
});

describe('invalid transitions are rejected (409)', () => {
  test.each([
    ['approve', 'PENDING'],
    ['approve', 'APPROVED'],
    ['approve', 'REJECTED'],
    ['approve', 'FULFILLED'],
    ['reject', 'PENDING'],
    ['reject', 'APPROVED'],
    ['reject', 'REJECTED'],
    ['reject', 'FULFILLED'],
  ])('HOD %s on %s request', async (action, status) => {
    const { r, hodAgent } = await setup('CSE', status);
    const res = await act(hodAgent, r._id, action, { reason: 'valid reason text' });
    expect(res.status).toBe(409);
    expect((await Request.findById(r._id)).status).toBe(status);
  });

  test.each(['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FULFILLED'])('clerk review on %s request', async (status) => {
    const { r, clerkAgent } = await setup('CSE', status);
    expect((await act(clerkAgent, r._id, 'review')).status).toBe(409);
    expect((await Request.findById(r._id)).status).toBe(status);
  });

  test('a request can only be reviewed once (second call 409, history not duplicated)', async () => {
    const { r, clerkAgent } = await setup();
    expect((await act(clerkAgent, r._id, 'review')).status).toBe(200);
    expect((await act(clerkAgent, r._id, 'review')).status).toBe(409);
    expect((await Request.findById(r._id)).statusHistory).toHaveLength(2);
  });
});

describe('input handling', () => {
  test('invalid id -> 400, unknown id -> 404', async () => {
    const { clerkAgent } = await setup();
    expect((await act(clerkAgent, 'nope', 'review')).status).toBe(400);
    expect((await act(clerkAgent, '64b7f0f0f0f0f0f0f0f0f0f0', 'review')).status).toBe(404);
  });

  test('SECURITY: body cannot force a status or decision fields', async () => {
    const { r, clerk, clerkAgent } = await setup();
    const res = await act(clerkAgent, r._id, 'review', { status: 'FULFILLED', decidedBy: String(clerk._id), department: 'ME' });
    expect(res.status).toBe(200);
    const stored = await Request.findById(r._id);
    expect(stored.status).toBe('UNDER_REVIEW');
    expect(stored.decidedBy).toBeNull();
    expect(stored.department).toBe('CSE');
  });
});

describe('concurrency (atomic transitions)', () => {
  test('SECURITY: simultaneous approve and reject -> exactly one wins', async () => {
    const { r, hodAgent } = await setup('CSE', 'UNDER_REVIEW');
    const hod2 = await createUser({ role: 'HOD', department: 'CSE' });
    const hod2Agent = await loginAgent(app, hod2);

    const [a, b] = await Promise.all([
      act(hodAgent, r._id, 'approve'),
      act(hod2Agent, r._id, 'reject', { reason: 'rejecting at the same moment' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const stored = await Request.findById(r._id);
    expect(['APPROVED', 'REJECTED']).toContain(stored.status);
    expect(stored.statusHistory).toHaveLength(2); // seeded PENDING entry plus exactly one decision
    expect(stored.statusHistory.filter((h) => h.to !== 'PENDING')).toHaveLength(1);
    // Winner and stored state agree
    const winner = a.status === 200 ? 'APPROVED' : 'REJECTED';
    expect(stored.status).toBe(winner);
    if (winner === 'APPROVED') expect(stored.rejectionReason).toBeNull();
  });

  test('simultaneous double approve -> one 200, one 409, one history entry', async () => {
    const { r, hodAgent } = await setup('CSE', 'UNDER_REVIEW');
    const hod2 = await createUser({ role: 'HOD', department: 'CSE' });
    const hod2Agent = await loginAgent(app, hod2);
    const results = await Promise.all([act(hodAgent, r._id, 'approve'), act(hod2Agent, r._id, 'approve')]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await Request.findById(r._id)).statusHistory.filter((h) => h.to === 'APPROVED')).toHaveLength(1);
  });

  test('simultaneous double review by two clerks -> one wins', async () => {
    const { r, clerkAgent } = await setup();
    const clerk2 = await createUser({ role: 'CLERK', department: 'CSE' });
    const clerk2Agent = await loginAgent(app, clerk2);
    const results = await Promise.all([act(clerkAgent, r._id, 'review'), act(clerk2Agent, r._id, 'review')]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
  });
});

describe('visibility of workflow results', () => {
  test('clerk sees APPROVED requests in the department queue (for the Phase 4 upload step)', async () => {
    const { clerkAgent } = await setup('CSE', 'APPROVED');
    const res = await clerkAgent.get('/api/requests?status=APPROVED');
    expect(res.body.data.total).toBe(1);
  });
});
