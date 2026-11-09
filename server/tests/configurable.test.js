'use strict';

// S2 gate: per-institution departments, document types and approval chain; the workflow
// engine on a custom three-step chain; NEEDS_INFO and resubmission; pinned versions;
// and a cross-tenant check for every new route.
process.env.NODE_ENV = 'test';
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, forgeToken, request,
  makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const config = require('../config/env');
const Request = require('../models/Request');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Department = require('../models/Department');
const WorkflowDefinition = require('../models/WorkflowDefinition');
const { buildRules, normaliseSteps, availableActions } = require('../services/workflowEngine');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const BODY = { documentType: 'Bonafide Certificate', purpose: 'Required for a bank education loan' };
const THREE = [
  { label: 'Clerk check', role: 'CLERK' },
  { label: 'HOD review', role: 'HOD' },
  { label: 'Principal sign-off', role: 'PRINCIPAL', canReject: true },
];
const patch = (agent, id, action, body) => agent.patch(`/api/requests/${id}/${action}`).set(CSRF).send(body || {});

async function cast(tenant, dept = 'CSE') {
  const t = tenant ? { tenant } : {};
  return {
    admin: await createUser({ role: 'ADMIN', ...t }),
    clerk: await createUser({ role: 'CLERK', department: dept, ...t }),
    hod: await createUser({ role: 'HOD', department: dept, ...t }),
    principal: await createUser({ role: 'PRINCIPAL', department: null, ...t }),
    student: await createUser({ role: 'STUDENT', department: dept, ...t }),
  };
}
async function agents(users, slug) {
  const out = {};
  for (const [k, u] of Object.entries(users)) out[k] = await loginAgent(app, u, 'Passw0rdTest', slug);
  return out;
}
async function setChain(adminAgent, steps = THREE) {
  const res = await adminAgent.put('/api/admin/workflow').set(CSRF).send({ steps });
  expect(res.status).toBe(200);
  return res.body.data.workflow;
}

describe('workflow engine (unit)', () => {
  test('(unit) a three-step chain derives the right rules', () => {
    const steps = normaliseSteps(THREE);
    const rules = buildRules({ steps });
    const key = (r) => `${r.kind}:${r.from}#${r.stepIndex}>${r.to}:${r.role}`;
    const list = rules.map(key);
    expect(list).toContain('advance:PENDING#0>UNDER_REVIEW:CLERK');
    expect(list).toContain('advance:UNDER_REVIEW#1>UNDER_REVIEW:HOD');
    expect(list).toContain('advance:UNDER_REVIEW#2>APPROVED:PRINCIPAL');
    expect(list).toContain('reject:UNDER_REVIEW#2>REJECTED:PRINCIPAL');
    expect(list).not.toContain('reject:UNDER_REVIEW#1>REJECTED:HOD');
    expect(list).toContain('needs_info:UNDER_REVIEW#1>NEEDS_INFO:HOD');
    expect(list).toContain('fulfil:APPROVED#2>FULFILLED:CLERK');
  });

  test('(unit) input is validated and keys and scope are derived, never trusted', () => {
    const steps = normaliseSteps([
      { label: 'Check', role: 'CLERK', key: 'evil', departmentScoped: false },
      { label: 'Check', role: 'PRINCIPAL', canReject: true, departmentScoped: true },
    ]);
    expect(steps.map((s) => s.key)).toEqual(['check', 'check-2']);
    expect(steps.map((s) => s.departmentScoped)).toEqual([true, false]);
    const bad = (input) => expect(() => normaliseSteps(input)).toThrow();
    bad([]);
    bad('x');
    bad(Array.from({ length: 7 }, () => ({ label: 'Step', role: 'CLERK', canReject: true })));
    bad([{ label: 'A', role: 'CLERK', canReject: true }]); // label too short
    bad([{ label: 'Valid', role: 'ADMIN', canReject: true }]); // admin cannot own a step
    bad([{ label: 'Valid', role: 'STUDENT', canReject: true }]);
    bad([{ label: 'Valid', role: 'CLERK' }]); // nobody can reject
    bad([{ label: 'Valid', role: 'CLERK', canReject: 'yes' }]);
  });

  test('(unit) available actions follow role, step and department', () => {
    const rules = buildRules({ steps: normaliseSteps(THREE) });
    const req = { status: 'UNDER_REVIEW', currentStepIndex: 1, department: 'CSE', studentId: 'S1' };
    expect(availableActions({ role: 'HOD', department: 'CSE' }, req, rules).sort()).toEqual(['advance', 'needs_info']);
    expect(availableActions({ role: 'HOD', department: 'ME' }, req, rules)).toEqual([]);
    expect(availableActions({ role: 'CLERK', department: 'CSE' }, req, rules)).toEqual([]);
    expect(availableActions({ role: 'PRINCIPAL', department: null }, { ...req, currentStepIndex: 2 }, rules).sort()).toEqual(['advance', 'needs_info', 'reject']);
    expect(availableActions({ role: 'STUDENT', _id: 'S1' }, { ...req, status: 'NEEDS_INFO' }, rules)).toEqual(['resubmit']);
    expect(availableActions({ role: 'STUDENT', _id: 'S2' }, { ...req, status: 'NEEDS_INFO' }, rules)).toEqual([]);
  });
});

describe('departments', () => {
  test('admin lists, creates, renames and deactivates; the code is immutable', async () => {
    const u = await cast();
    const { admin } = await agents(u);
    const list = await admin.get('/api/admin/departments');
    expect(list.body.data.items.map((d) => d.code)).toEqual(['CIVIL', 'CSE', 'ECE', 'EEE', 'ME']);

    const created = await admin.post('/api/admin/departments').set(CSRF).send({ code: ' it ', name: 'Information Technology' });
    expect(created.status).toBe(201);
    expect(created.body.data.department.code).toBe('IT');
    const id = created.body.data.department._id;

    expect((await admin.post('/api/admin/departments').set(CSRF).send({ code: 'IT', name: 'Another' })).status).toBe(409);
    expect((await admin.post('/api/admin/departments').set(CSRF).send({ code: 'X', name: 'Too short code' })).status).toBe(400);
    expect((await admin.post('/api/admin/departments').set(CSRF).send({ code: 'BAD CODE', name: 'Spaces' })).status).toBe(400);

    const renamed = await admin.patch(`/api/admin/departments/${id}`).set(CSRF).send({ name: 'IT and Computing' });
    expect(renamed.body.data.department.name).toBe('IT and Computing');
    expect((await admin.patch(`/api/admin/departments/${id}`).set(CSRF).send({ code: 'NEW' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/departments/${id}`).set(CSRF).send({ isActive: 'no' })).status).toBe(400);
    const off = await admin.patch(`/api/admin/departments/${id}`).set(CSRF).send({ isActive: false });
    expect(off.body.data.department.isActive).toBe(false);

    const actions = (await AuditLog.find({})).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED']));
  });

  test('only an Admin may configure; everyone else gets 403 and anonymous gets 401', async () => {
    const u = await cast();
    const a = await agents(u);
    for (const who of ['clerk', 'hod', 'principal', 'student']) {
      expect((await a[who].get('/api/admin/departments')).status).toBe(403);
      expect((await a[who].post('/api/admin/departments').set(CSRF).send({ code: 'ZZ', name: 'Nope' })).status).toBe(403);
      expect((await a[who].get('/api/admin/document-types')).status).toBe(403);
      expect((await a[who].get('/api/admin/workflow')).status).toBe(403);
      expect((await a[who].put('/api/admin/workflow').set(CSRF).send({ steps: THREE })).status).toBe(403);
    }
    expect((await request(app).get('/api/admin/departments')).status).toBe(401);
    expect((await request(app).put('/api/admin/workflow').set(CSRF).send({ steps: THREE })).status).toBe(401);
  });

  test('a deactivated department stops new sign-ups and staff, but nobody already in it is cut off', async () => {
    const u = await cast(null, 'CSE');
    const { admin, student } = await agents(u);
    const dept = await Department.findOne({ code: 'ECE' });
    await admin.patch(`/api/admin/departments/${dept._id}`).set(CSRF).send({ isActive: false });

    const pub = await request(app).get('/api/meta/departments');
    expect(pub.status).toBe(200);
    expect(pub.body.data.items.map((d) => d.code)).not.toContain('ECE');

    const reg = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'New Person', email: 'new@example.com', password: 'Passw0rdX1', department: 'ECE' });
    expect(reg.status).toBe(400);
    const staff = await admin.post('/api/admin/users').set(CSRF).send({ name: 'Eve Clerk', email: 'eve@example.com', password: 'Passw0rdX1', role: 'CLERK', department: 'ECE' });
    expect(staff.status).toBe(400);
    expect((await admin.patch(`/api/admin/users/${u.student._id}`).set(CSRF).send({ department: 'ECE' })).status).toBe(400);

    // Existing users in a deactivated department keep working.
    const ece = await createUser({ role: 'STUDENT', department: 'ECE' });
    const eceAgent = await loginAgent(app, ece);
    expect((await eceAgent.post('/api/requests').set(CSRF).send(BODY)).status).toBe(201);
    expect((await student.post('/api/requests').set(CSRF).send(BODY)).status).toBe(201);
  });

  test('public registration uses the institution list, and a custom department works end to end', async () => {
    const u = await cast();
    const { admin } = await agents(u);
    await admin.post('/api/admin/departments').set(CSRF).send({ code: 'LAW', name: 'School of Law' });
    const reg = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Law Student', email: 'law@example.com', password: 'Passw0rdX1', department: 'law' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.department).toBe('LAW');
    expect((await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Bad Dept', email: 'bad@example.com', password: 'Passw0rdX1', department: 'NOPE' })).status).toBe(400);
  });
});

describe('document types', () => {
  test('create, rename and deactivate; case-insensitive duplicates; requests keep their stored name', async () => {
    const u = await cast();
    const { admin, student } = await agents(u);
    expect((await admin.post('/api/admin/document-types').set(CSRF).send({ name: 'transcript' })).status).toBe(409);
    const created = await admin.post('/api/admin/document-types').set(CSRF).send({ name: 'Migration Certificate' });
    expect(created.status).toBe(201);
    const id = created.body.data.documentType._id;

    const made = await student.post('/api/requests').set(CSRF).send({ documentType: 'migration certificate', purpose: 'Needed for a transfer abroad' });
    expect(made.status).toBe(201);
    expect(made.body.data.request.documentType).toBe('Migration Certificate'); // canonical name stored

    await admin.patch(`/api/admin/document-types/${id}`).set(CSRF).send({ name: 'Migration Cert', isActive: false });
    const after = await student.get(`/api/requests/${made.body.data.request._id}`);
    expect(after.body.data.request.documentType).toBe('Migration Certificate'); // history is not rewritten

    const blocked = await student.post('/api/requests').set(CSRF).send({ documentType: 'Migration Cert', purpose: 'Needed for a transfer abroad' });
    expect(blocked.status).toBe(400);
    expect((await student.post('/api/requests').set(CSRF).send({ documentType: 'Made Up', purpose: 'Needed for a transfer abroad' })).status).toBe(400);

    const opts = await student.get('/api/meta/options');
    expect(opts.body.data.documentTypes).not.toContain('Migration Cert');
    expect(opts.body.data.documentTypes).toContain('Transcript');
    const all = await admin.get('/api/admin/document-types');
    expect(all.body.data.items.find((t) => t._id === id).isActive).toBe(false);
  });
});

describe('workflow configuration', () => {
  test('default definition is version 1; editing creates version 2 and warns about missing staff', async () => {
    const u = await cast();
    const { admin } = await agents(u);
    const v1 = await admin.get('/api/admin/workflow');
    expect(v1.body.data.workflow.version).toBe(1);
    expect(v1.body.data.workflow.steps.map((s) => s.role)).toEqual(['CLERK', 'HOD']);

    const v2 = await setChain(admin);
    expect(v2.version).toBe(2);
    expect(v2.steps.map((s) => [s.key, s.role, s.departmentScoped, s.canReject])).toEqual([
      ['clerk-check', 'CLERK', true, false],
      ['hod-review', 'HOD', true, false],
      ['principal-sign-off', 'PRINCIPAL', false, true],
    ]);
    expect(v2.rolesWithoutActiveStaff).toEqual([]);
    // Versions are immutable records: version 1 still exists unchanged.
    expect(await WorkflowDefinition.countDocuments({})).toBe(2);
    expect((await WorkflowDefinition.findOne({ version: 1 })).steps).toHaveLength(2);
    expect((await AuditLog.find({ action: 'WORKFLOW_UPDATED' })).length).toBe(1);

    await User.updateOne({ _id: u.principal._id }, { isActive: false });
    const g = await admin.get('/api/admin/workflow');
    expect(g.body.data.workflow.rolesWithoutActiveStaff).toEqual(['PRINCIPAL']);
  });

  test('invalid chains are rejected with 400 and change nothing', async () => {
    const u = await cast();
    const { admin } = await agents(u);
    const put = (steps) => admin.put('/api/admin/workflow').set(CSRF).send({ steps });
    expect((await put([])).status).toBe(400);
    expect((await put('nope')).status).toBe(400);
    expect((await put([{ label: 'Only', role: 'CLERK' }])).status).toBe(400); // nobody can reject
    expect((await put([{ label: 'Boss', role: 'ADMIN', canReject: true }])).status).toBe(400);
    expect((await put([{ label: 'X', role: 'CLERK', canReject: true }])).status).toBe(400);
    expect((await put(Array.from({ length: 7 }, (_, i) => ({ label: `Step ${i}`, role: 'CLERK', canReject: true })))).status).toBe(400);
    expect(await WorkflowDefinition.countDocuments({})).toBe(1);
  });

  test('requests are pinned to the version they started with, so editing never reroutes work in progress', async () => {
    const u = await cast();
    const a = await agents(u);
    const old = await a.student.post('/api/requests').set(CSRF).send(BODY);
    expect(old.status).toBe(201);
    expect(old.body.data.request.currentStepIndex).toBe(0);

    const v2 = await setChain(a.admin);
    expect(v2.requestsOnOlderVersions).toBe(1);
    const fresh = await a.student.post('/api/requests').set(CSRF).send(BODY);
    expect(String(fresh.body.data.request.workflowDefinitionId)).not.toBe(String(old.body.data.request.workflowDefinitionId));

    // The old request still finishes on the two-step chain: Clerk, then HOD approves.
    await patch(a.clerk, old.body.data.request._id, 'advance');
    const approved = await patch(a.hod, old.body.data.request._id, 'advance');
    expect(approved.body.data.request.status).toBe('APPROVED');
    // The new request needs the Principal after the HOD.
    await patch(a.clerk, fresh.body.data.request._id, 'advance');
    const hodStep = await patch(a.hod, fresh.body.data.request._id, 'advance');
    expect(hodStep.body.data.request.status).toBe('UNDER_REVIEW');
  });

  test('every institution has its own configuration: A cannot read or edit B', async () => {
    const A = getDefaultTenant();
    const B = await makeTenant('beta-college');
    const ua = await cast();
    const ub = await cast(B);
    const a = await agents(ua);
    const b = await agents(ub, 'beta-college');
    await setChain(a.admin); // A is now on version 2
    expect((await b.admin.get('/api/admin/workflow')).body.data.workflow.version).toBe(1);

    const bDept = await runAsTenant(B._id, () => Department.findOne({ code: 'CSE' }));
    const bType = await runAsTenant(B._id, () => require('../models/DocumentType').findOne({ name: 'Transcript' }));
    expect((await a.admin.patch(`/api/admin/departments/${bDept._id}`).set(CSRF).send({ isActive: false })).status).toBe(404);
    expect((await a.admin.patch(`/api/admin/document-types/${bType._id}`).set(CSRF).send({ isActive: false })).status).toBe(404);
    expect((await runUnscoped(() => Department.findById(bDept._id))).isActive).toBe(true);

    // The same code can exist in both institutions, with different names.
    await a.admin.patch(`/api/admin/departments/${(await Department.findOne({ code: 'CSE' }))._id}`).set(CSRF).send({ name: 'A Computing' });
    const bList = await b.admin.get('/api/admin/departments');
    expect(bList.body.data.items.find((d) => d.code === 'CSE').name).toBe('Computer Science and Engineering');
    expect(await runAsTenant(A._id, () => WorkflowDefinition.countDocuments({}))).toBe(2);
    expect(await runAsTenant(B._id, () => WorkflowDefinition.countDocuments({}))).toBe(1);

    // A session from A is useless on B for every new configuration route.
    const token = forgeToken(ua.admin._id);
    const probes = [
      ['get', '/api/admin/departments'], ['post', '/api/admin/departments'], ['patch', `/api/admin/departments/${bDept._id}`],
      ['get', '/api/admin/document-types'], ['post', '/api/admin/document-types'], ['patch', `/api/admin/document-types/${bType._id}`],
      ['get', '/api/admin/workflow'], ['put', '/api/admin/workflow'], ['get', '/api/meta/options'],
    ];
    for (const [method, url] of probes) {
      const res = await request(app, 'beta-college')[method](url).set(CSRF).set('Cookie', `${config.cookieName}=${token}`).send({});
      expect([url, res.status]).toEqual([url, 401]);
    }
  });

  test('public department list shows only that institution, and options need a session', async () => {
    const B = await makeTenant('beta-college');
    await runAsTenant(B._id, () => Department.create({ code: 'ARCH', name: 'Architecture' }));
    const a = await request(app).get('/api/meta/departments');
    const b = await request(app, 'beta-college').get('/api/meta/departments');
    expect(a.body.data.items.map((d) => d.code)).not.toContain('ARCH');
    expect(b.body.data.items.map((d) => d.code)).toContain('ARCH');
    expect((await request(app).get('/api/meta/options')).status).toBe(401);
    expect((await request(app, 'nope-college').get('/api/meta/departments')).status).toBe(404);
  });
});

describe('a custom three-step chain, end to end', () => {
  test('Clerk -> HOD -> Principal -> document upload -> student download', async () => {
    const u = await cast();
    const a = await agents(u);
    await setChain(a.admin);

    const made = await a.student.post('/api/requests').set(CSRF).send(BODY);
    const id = made.body.data.request._id;
    expect(made.body.data.request.currentStepIndex).toBe(0);

    // Out of turn: nobody else can act while the Clerk's step is current.
    expect((await patch(a.hod, id, 'advance')).status).toBe(409); // a HOD step exists, but not yet
    expect((await patch(a.principal, id, 'advance')).status).toBe(403); // no Principal action leads here
    expect((await patch(a.hod, id, 'reject', { reason: 'Not yours to reject' })).status).toBe(403);

    const s1 = await patch(a.clerk, id, 'advance');
    expect(s1.status).toBe(200);
    expect(s1.body.data.request).toMatchObject({ status: 'UNDER_REVIEW', currentStepIndex: 1 });
    expect(String(s1.body.data.request.reviewedBy)).toBe(String(u.clerk._id));

    expect((await patch(a.clerk, id, 'advance')).status).toBe(409); // right role, but the request has moved on
    expect((await patch(a.principal, id, 'advance')).status).toBe(403); // not yet the principal's
    const s2 = await patch(a.hod, id, 'advance');
    expect(s2.body.data.request).toMatchObject({ status: 'UNDER_REVIEW', currentStepIndex: 2 });
    expect(s2.body.data.request.decidedBy).toBeNull(); // not decided until the last step

    // The HOD's step did not allow rejection; the Principal's does, and acts across departments.
    expect((await patch(a.principal, id, 'advance')).status).toBe(200);
    const detail = await a.student.get(`/api/requests/${id}`);
    expect(detail.body.data.request.status).toBe('APPROVED');
    expect(String(detail.body.data.request.decidedBy)).toBe(String(u.principal._id));
    expect(detail.body.data.request.currentStep).toBe('Awaiting document upload');

    const up = await a.clerk.post(`/api/requests/${id}/document`).set(CSRF).attach('document', PDF, { filename: 'a.pdf' });
    expect(up.status).toBe(200);
    expect(up.body.data.request.status).toBe('FULFILLED');
    expect((await a.student.get(`/api/requests/${id}/document`)).status).toBe(200);
    expect((await a.principal.get(`/api/requests/${id}/document`)).status).toBe(403); // no document access
    expect((await a.admin.get(`/api/requests/${id}/document`)).status).toBe(403);

    const stored = await Request.findById(id);
    expect(stored.statusHistory.map((h) => `${h.from}>${h.to}`)).toEqual([
      'null>PENDING', 'PENDING>UNDER_REVIEW', 'UNDER_REVIEW>UNDER_REVIEW', 'UNDER_REVIEW>APPROVED', 'APPROVED>FULFILLED',
    ]);
    expect(stored.statusHistory.slice(1, 4).map((h) => h.step)).toEqual(['Clerk check', 'HOD review', 'Principal sign-off']);
    const audits = (await AuditLog.find({ requestId: id }).sort({ timestamp: 1, _id: 1 })).map((l) => l.action);
    expect(audits).toEqual(['REQUEST_SUBMITTED', 'REQUEST_REVIEWED', 'REQUEST_REVIEWED', 'REQUEST_APPROVED', 'DOCUMENT_UPLOADED', 'REQUEST_FULFILLED', 'DOCUMENT_DOWNLOADED']);
  });

  test('the Principal can reject at their step with a reason, and only there', async () => {
    const u = await cast();
    const a = await agents(u);
    await setChain(a.admin);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    await patch(a.clerk, id, 'advance');
    await patch(a.hod, id, 'advance');
    expect((await patch(a.principal, id, 'reject', { reason: '   ' })).status).toBe(400);
    const rej = await patch(a.principal, id, 'reject', { reason: 'Outstanding dues must be cleared' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.request).toMatchObject({ status: 'REJECTED', rejectionReason: 'Outstanding dues must be cleared' });
    expect((await patch(a.principal, id, 'advance')).status).toBe(409); // already decided
  });

  test('step scope: department staff act only in their own department, the Principal across all', async () => {
    const cse = await cast(null, 'CSE');
    const me = {
      clerk: await createUser({ role: 'CLERK', department: 'ME' }),
      hod: await createUser({ role: 'HOD', department: 'ME' }),
      student: await createUser({ role: 'STUDENT', department: 'ME' }),
    };
    const a = await agents(cse);
    const m = await agents(me);
    await setChain(a.admin);
    const cseReq = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    const meReq = (await m.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;

    expect((await patch(m.clerk, cseReq, 'advance')).status).toBe(404); // other department: invisible
    expect((await patch(a.clerk, meReq, 'advance')).status).toBe(404);
    expect((await m.clerk.get(`/api/requests/${cseReq}`)).status).toBe(404);

    await patch(a.clerk, cseReq, 'advance');
    await patch(m.clerk, meReq, 'advance');
    await patch(a.hod, cseReq, 'advance');
    await patch(m.hod, meReq, 'advance');
    // Principal sees both departments and approves each.
    const list = await a.principal.get('/api/requests?limit=100');
    expect(list.body.data.items.map((r) => r._id).sort()).toEqual([cseReq, meReq].sort());
    expect(list.body.data.items.every((r) => r.actions.includes('advance'))).toBe(true);
    expect((await patch(a.principal, cseReq, 'advance')).status).toBe(200);
    expect((await patch(a.principal, meReq, 'advance')).status).toBe(200);
  });

  test('two simultaneous approvals on a custom step: exactly one wins', async () => {
    const u = await cast();
    const hod2 = await createUser({ role: 'HOD', department: 'CSE' });
    const a = await agents(u);
    const h2 = await loginAgent(app, hod2);
    await setChain(a.admin);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    await patch(a.clerk, id, 'advance');
    const results = await Promise.all([patch(a.hod, id, 'advance'), patch(h2, id, 'advance')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await Request.findById(id);
    expect(stored.currentStepIndex).toBe(2);
    expect(stored.statusHistory.filter((h) => h.step === 'HOD review')).toHaveLength(1);
  });

  test('a one-step chain approves straight from PENDING', async () => {
    const u = await cast();
    const a = await agents(u);
    await setChain(a.admin, [{ label: 'HOD only', role: 'HOD', canReject: true }]);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    expect((await patch(a.clerk, id, 'advance')).status).toBe(403);
    const res = await patch(a.hod, id, 'advance');
    expect(res.body.data.request.status).toBe('APPROVED');
    expect(String(res.body.data.request.reviewedBy)).toBe(String(u.hod._id));
    expect(String(res.body.data.request.decidedBy)).toBe(String(u.hod._id));
  });

  test('invalid transitions are 409, and role mistakes are 403, on a custom chain', async () => {
    const u = await cast();
    const a = await agents(u);
    await setChain(a.admin);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    expect((await patch(a.hod, id, 'approve')).status).toBe(403); // the HOD's step cannot approve outright
    await patch(a.clerk, id, 'review');
    expect((await patch(a.clerk, id, 'review')).status).toBe(409); // right role, wrong moment
    expect((await patch(a.student, id, 'advance')).status).toBe(403);
    expect((await patch(a.admin, id, 'advance')).status).toBe(403);
    expect((await a.clerk.post(`/api/requests/${id}/document`).set(CSRF).attach('document', PDF, { filename: 'a.pdf' })).status).toBe(409);
    expect((await patch(a.clerk, '64b64b64b64b64b64b64b640', 'advance')).status).toBe(404);
  });
});

describe('NEEDS_INFO and resubmission', () => {
  test('a reviewer asks, the student answers, and it returns to the same step', async () => {
    const u = await cast();
    const other = await createUser({ role: 'STUDENT', department: 'CSE' });
    const a = await agents(u);
    const o = await loginAgent(app, other);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;

    expect((await patch(a.clerk, id, 'needs-info', { note: 'ok' })).status).toBe(400); // too short
    expect((await patch(a.clerk, id, 'needs-info', {})).status).toBe(400);
    const asked = await patch(a.clerk, id, 'needs-info', { note: 'Please state the bank name in the purpose' });
    expect(asked.status).toBe(200);
    expect(asked.body.data.request.status).toBe('NEEDS_INFO');

    const seen = await a.student.get(`/api/requests/${id}`);
    expect(seen.body.data.request.actions).toEqual(['resubmit']);
    expect(seen.body.data.request.statusHistory.at(-1).note).toBe('Please state the bank name in the purpose');
    expect((await a.clerk.get(`/api/requests/${id}`)).body.data.request.actions).toEqual([]);

    expect((await patch(a.clerk, id, 'advance')).status).toBe(409); // frozen while waiting
    expect((await patch(a.hod, id, 'needs-info', { note: 'Not in your turn' })).status).toBe(409);
    expect((await patch(o, id, 'resubmit')).status).toBe(404); // someone else's request
    expect((await patch(a.clerk, id, 'resubmit')).status).toBe(403); // staff cannot answer for the student

    expect((await patch(a.student, id, 'resubmit', { purpose: 'short' })).status).toBe(400);
    const back = await patch(a.student, id, 'resubmit', { purpose: 'Required for the State Bank education loan' });
    expect(back.status).toBe(200);
    expect(back.body.data.request).toMatchObject({ status: 'PENDING', currentStepIndex: 0, purpose: 'Required for the State Bank education loan' });
    expect((await patch(a.student, id, 'resubmit')).status).toBe(409); // no longer waiting

    expect((await patch(a.clerk, id, 'advance')).status).toBe(200); // same reviewer carries on
    const actions = (await AuditLog.find({ requestId: id })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['REQUEST_INFO_REQUESTED', 'REQUEST_RESUBMITTED']));
  });

  test('asked at a later step, it returns to that step (UNDER_REVIEW), not the start', async () => {
    const u = await cast();
    const a = await agents(u);
    const id = (await a.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    await patch(a.clerk, id, 'advance');
    await patch(a.hod, id, 'needs-info', { note: 'Attach the fee clearance number' });
    const back = await patch(a.student, id, 'resubmit');
    expect(back.body.data.request).toMatchObject({ status: 'UNDER_REVIEW', currentStepIndex: 1 });
    const done = await patch(a.hod, id, 'approve');
    expect(done.body.data.request.status).toBe('APPROVED');
    const stored = await Request.findById(id);
    expect(stored.statusHistory.map((h) => h.to)).toEqual(['PENDING', 'UNDER_REVIEW', 'NEEDS_INFO', 'UNDER_REVIEW', 'APPROVED']);
  });

  test('a NEEDS_INFO request cannot be rejected, fulfilled or asked again', async () => {
    const u = await cast();
    const a = await agents(u);
    const r = await createRequest(u.student, { status: 'UNDER_REVIEW' });
    await patch(a.hod, r._id, 'needs-info', { note: 'Need one more document' });
    expect((await patch(a.hod, r._id, 'reject', { reason: 'Changed my mind' })).status).toBe(409);
    expect((await patch(a.hod, r._id, 'needs-info', { note: 'Asking twice please' })).status).toBe(409);
    expect((await a.clerk.post(`/api/requests/${r._id}/document`).set(CSRF).attach('document', PDF, { filename: 'a.pdf' })).status).toBe(409);
  });

  test('status filter accepts NEEDS_INFO and rejects unknown values', async () => {
    const u = await cast();
    const a = await agents(u);
    await createRequest(u.student, { status: 'NEEDS_INFO' });
    const res = await a.clerk.get('/api/requests?status=NEEDS_INFO');
    expect(res.body.data.items).toHaveLength(1);
    expect((await a.clerk.get('/api/requests?status=BOGUS')).status).toBe(400);
  });
});

describe('Principal role and staff accounts', () => {
  test('admin creates a Principal without a department; other staff still need one', async () => {
    const u = await cast();
    const { admin } = await agents(u);
    const make = (body) => admin.post('/api/admin/users').set(CSRF).send({ name: 'Dr Principal', email: `p${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'Passw0rdX1', ...body });
    const ok1 = await make({ role: 'PRINCIPAL' });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.user.department).toBeNull();
    const ok2 = await make({ role: 'PRINCIPAL', department: 'CSE' }); // ignored, not stored
    expect(ok2.body.data.user.department).toBeNull();
    expect((await make({ role: 'CLERK' })).status).toBe(400);
    expect((await make({ role: 'HOD', department: 'NOPE' })).status).toBe(400);
    expect((await make({ role: 'ADMIN', department: 'CSE' })).status).toBe(400); // admins are not creatable
    const cannot = await admin.patch(`/api/admin/users/${ok1.body.data.user._id}`).set(CSRF).send({ department: 'CSE' });
    expect(cannot.status).toBe(400);
  });

  test('a Principal has read access to the institution, no admin powers, and a login works', async () => {
    const u = await cast();
    const a = await agents(u);
    await createRequest(u.student, {});
    const list = await a.principal.get('/api/requests');
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect((await a.principal.get('/api/admin/users')).status).toBe(403);
    expect((await a.principal.post('/api/requests').set(CSRF).send(BODY)).status).toBe(403);
  });

  test('cross-tenant: a Principal of A cannot see or act on B, even on a shared chain shape', async () => {
    const B = await makeTenant('beta-college');
    const ua = await cast();
    const ub = await cast(B);
    const a = await agents(ua);
    const b = await agents(ub, 'beta-college');
    await setChain(a.admin);
    await setChain(b.admin);
    const bId = (await b.student.post('/api/requests').set(CSRF).send(BODY)).body.data.request._id;
    await patch(b.clerk, bId, 'advance');
    await patch(b.hod, bId, 'advance');

    expect((await a.principal.get(`/api/requests/${bId}`)).status).toBe(404);
    expect((await patch(a.principal, bId, 'advance')).status).toBe(404);
    expect((await patch(a.principal, bId, 'reject', { reason: 'Wrongly targeted' })).status).toBe(404);
    expect((await patch(a.principal, bId, 'needs-info', { note: 'Wrongly targeted' })).status).toBe(404);
    expect((await patch(a.student, bId, 'resubmit')).status).toBe(404);
    expect((await a.principal.get('/api/requests')).body.data.items).toHaveLength(0);
    expect((await Request.collection.findOne({ _id: new (require('mongoose').Types.ObjectId)(bId) })).status).toBe('UNDER_REVIEW');
  });
});
