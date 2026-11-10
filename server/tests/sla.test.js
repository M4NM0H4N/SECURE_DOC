'use strict';

// S5 gate: per-step SLAs. Timers start and stop with the workflow, reminders and escalations fire
// exactly once (the clock is moved by passing `now`, nothing is waited for), and nothing is
// reassigned or approved automatically.
process.env.NODE_ENV = 'test';
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, request, makeTenant,
} = require('./helpers');
const config = require('../config/env');
const mailer = require('../services/mailer');
const worker = require('../services/notificationWorker');
const sla = require('../services/slaService');
const { slaTimers, normaliseSteps } = require('../services/workflowEngine');
const Notification = require('../models/Notification');
const Request = require('../models/Request');
const { runUnscoped } = require('./helpers');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Notification.collection.deleteMany({});
  mailer.clearOutbox();
  config.mailProvider = 'outbox';
});

const HOUR = 3600 * 1000;
const BODY = { documentType: 'Transcript', purpose: 'Needed for a visa application' };
const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const patch = (agent, id, action, body) => agent.patch(`/api/requests/${id}/${action}`).set(CSRF).send(body || {});
const rows = (filter) => runUnscoped(() => Notification.find(filter).lean());
const byType = async (type) => (await rows({ type })).filter((n) => n.channel === 'IN_APP');
const getReq = (id) => runUnscoped(() => Request.findById(id).lean());

const SLA_CHAIN = [
  { label: 'Clerk check', role: 'CLERK', slaHours: 8, escalateTo: 'HOD' },
  { label: 'HOD review', role: 'HOD', canReject: true, slaHours: 24, escalateTo: 'PRINCIPAL' },
];

async function world(tenant, slug) {
  const t = tenant ? { tenant } : {};
  const u = {
    student: await createUser({ role: 'STUDENT', department: 'CSE', ...t }),
    clerk: await createUser({ role: 'CLERK', department: 'CSE', ...t }),
    clerkMe: await createUser({ role: 'CLERK', department: 'ME', ...t }),
    hod: await createUser({ role: 'HOD', department: 'CSE', ...t }),
    hodMe: await createUser({ role: 'HOD', department: 'ME', ...t }),
    principal: await createUser({ role: 'PRINCIPAL', department: null, ...t }),
    admin: await createUser({ role: 'ADMIN', ...t }),
  };
  const a = {};
  for (const [k, user] of Object.entries(u)) a[k] = await loginAgent(app, user, 'Passw0rdTest', slug);
  return { ...u, a };
}
async function setChain(w, steps = SLA_CHAIN) {
  const res = await w.a.admin.put('/api/admin/workflow').set(CSRF).send({ steps });
  expect(res.status).toBe(200);
  return res.body.data.workflow;
}
const submit = async (w) => (await post(w.a.student, '/api/requests', BODY)).body.data.request._id;

describe('SLA settings on a workflow step', () => {
  test('(unit) timers: reminder at 75% of the time, escalation at the deadline, none without an SLA', () => {
    const t0 = new Date('2026-01-01T09:00:00Z');
    const t = slaTimers({ slaHours: 8 }, t0);
    expect(t.stepEnteredAt).toEqual(t0);
    expect(t.slaReminderAt.getTime() - t0.getTime()).toBe(6 * HOUR);
    expect(t.slaDueAt.getTime() - t0.getTime()).toBe(8 * HOUR);
    for (const none of [{ slaHours: null }, {}, undefined, null]) expect(slaTimers(none, t0)).toEqual({ stepEnteredAt: t0, slaReminderAt: null, slaDueAt: null });
  });

  test('(unit) input is validated: whole hours 1-720, escalation needs an SLA and a different valid role', () => {
    const ok = (extra) => normaliseSteps([{ label: 'Clerk check', role: 'CLERK', canReject: true, ...extra }]);
    expect(ok({ slaHours: 8, escalateTo: 'HOD' })[0]).toMatchObject({ slaHours: 8, escalateTo: 'HOD' });
    expect(ok({})[0]).toMatchObject({ slaHours: null, escalateTo: null });
    expect(ok({ slaHours: null, escalateTo: '' })[0]).toMatchObject({ slaHours: null, escalateTo: null });
    for (const bad of [{ slaHours: 0 }, { slaHours: 721 }, { slaHours: 1.5 }, { slaHours: '8' }, { slaHours: -1 }, { escalateTo: 'HOD' }, { slaHours: 8, escalateTo: 'CLERK' }, { slaHours: 8, escalateTo: 'ADMIN' }, { slaHours: 8, escalateTo: 'STUDENT' }]) {
      expect(() => ok(bad)).toThrow();
    }
  });

  test('the Admin saves SLAs with the chain; they are part of the version and invalid ones change nothing', async () => {
    const w = await world();
    const saved = await setChain(w);
    expect(saved.steps.map((s) => [s.slaHours, s.escalateTo])).toEqual([[8, 'HOD'], [24, 'PRINCIPAL']]);
    expect((await w.a.admin.get('/api/admin/workflow')).body.data.workflow.steps[0]).toMatchObject({ slaHours: 8, escalateTo: 'HOD' });
    const bad = await w.a.admin.put('/api/admin/workflow').set(CSRF).send({ steps: [{ label: 'Only step', role: 'CLERK', canReject: true, slaHours: 0 }] });
    expect(bad.status).toBe(400);
    expect((await w.a.admin.get('/api/admin/workflow')).body.data.workflow.version).toBe(saved.version);
  });
});

describe('the SLA clock follows the workflow', () => {
  test('starts when a step is entered, restarts for the next step, and stops when the request leaves the timed steps', async () => {
    const w = await world();
    await setChain(w);
    const before = Date.now();
    const id = await submit(w);
    let r = await getReq(id);
    expect(r.stepEnteredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r.slaDueAt.getTime() - r.stepEnteredAt.getTime()).toBe(8 * HOUR);
    expect(r.slaReminderAt.getTime() - r.stepEnteredAt.getTime()).toBe(6 * HOUR);

    await patch(w.a.clerk, id, 'advance');
    r = await getReq(id);
    expect(r.slaDueAt.getTime() - r.stepEnteredAt.getTime()).toBe(24 * HOUR); // the HOD step's own SLA
    expect(r.slaReminderAt.getTime() - r.stepEnteredAt.getTime()).toBe(18 * HOUR);

    await patch(w.a.hod, id, 'advance'); // approved: this chain has no timed step left
    r = await getReq(id);
    expect(r).toMatchObject({ status: 'APPROVED', slaDueAt: null, slaReminderAt: null });
  });

  test('a step without an SLA has no timers, and the default chain has none at all', async () => {
    const w = await world();
    const id = await submit(w); // default chain
    expect(await getReq(id)).toMatchObject({ slaDueAt: null, slaReminderAt: null });
    expect(await sla.scan({ now: new Date(Date.now() + 1000 * HOUR) })).toEqual({ reminders: 0, escalations: 0 });
  });

  test('waiting for the student pauses the clock; the answer restarts it from that moment', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const started = await getReq(id);
    await patch(w.a.clerk, id, 'needs-info', { note: 'Please add your roll number' });
    expect(await getReq(id)).toMatchObject({ status: 'NEEDS_INFO', slaDueAt: null, slaReminderAt: null });
    // However long the student takes, nothing is due.
    expect(await sla.scan({ now: new Date(Date.now() + 500 * HOUR) })).toEqual({ reminders: 0, escalations: 0 });

    await w.a.student.patch(`/api/requests/${id}/resubmit`).set(CSRF).send({});
    const resumed = await getReq(id);
    expect(resumed.status).toBe('PENDING');
    expect(resumed.stepEnteredAt.getTime()).toBeGreaterThanOrEqual(started.stepEnteredAt.getTime());
    expect(resumed.slaDueAt.getTime() - resumed.stepEnteredAt.getTime()).toBe(8 * HOUR);
  });

  test('rejection and fulfilment stop the clock too', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    await patch(w.a.clerk, id, 'advance');
    await patch(w.a.hod, id, 'reject', { reason: 'Outstanding fees' });
    expect(await getReq(id)).toMatchObject({ status: 'REJECTED', slaDueAt: null, slaReminderAt: null });
  });
});

describe('reminders and escalations fire exactly once', () => {
  test('reminder at 75%, escalation at the deadline, each once, to the right people only', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const r = await getReq(id);

    // Before the reminder time: nothing.
    expect(await sla.scan({ now: new Date(r.slaReminderAt.getTime() - 1000) })).toEqual({ reminders: 0, escalations: 0 });

    // Reminder: the owners of the current step (Clerks of the department).
    const rem = new Date(r.slaReminderAt.getTime() + 1000);
    expect(await sla.scan({ now: rem })).toEqual({ reminders: 1, escalations: 0 });
    expect((await byType('SLA_REMINDER')).map((n) => String(n.userId))).toEqual([String(w.clerk._id)]);
    expect((await rows({ type: 'SLA_REMINDER', channel: 'EMAIL' })).map((n) => String(n.userId))).toEqual([String(w.clerk._id)]);
    expect(await sla.scan({ now: rem })).toEqual({ reminders: 0, escalations: 0 }); // not again

    // Escalation: the role named by the step (HOD), of the same department, once.
    const due = new Date(r.slaDueAt.getTime() + 1000);
    expect(await sla.scan({ now: due })).toEqual({ reminders: 0, escalations: 1 });
    expect((await byType('SLA_ESCALATION')).map((n) => String(n.userId))).toEqual([String(w.hod._id)]);
    expect(await byType('SLA_ESCALATION')).toHaveLength(1);
    expect(await sla.scan({ now: new Date(due.getTime() + 100 * HOUR) })).toEqual({ reminders: 0, escalations: 0 });
    expect(await getReq(id)).toMatchObject({ slaDueAt: null, slaReminderAt: null });

    // Nothing was reassigned or decided: the request is exactly where it was, and the Clerk can still act.
    expect(await getReq(id)).toMatchObject({ status: 'PENDING', currentStepIndex: 0 });
    expect((await patch(w.a.clerk, id, 'advance')).status).toBe(200);

    // The mails go out through the normal worker.
    await worker.runOnce();
    expect(mailer.lastTo(w.clerk.email, 'sla-reminder').message.subject).toContain('Reminder');
    expect(mailer.lastTo(w.hod.email, 'sla-escalation').message.text).toContain('Clerk check');
    expect(mailer.lastTo(w.hodMe.email, 'sla-escalation')).toBeNull(); // other department's HOD is not involved
  });

  test('if the deadline has passed before anyone looked, only the escalation is sent (no stale reminder)', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const r = await getReq(id);
    expect(await sla.scan({ now: new Date(r.slaDueAt.getTime() + HOUR) })).toEqual({ reminders: 0, escalations: 1 });
    expect(await byType('SLA_REMINDER')).toHaveLength(0);
  });

  test('a Principal escalation reaches the Principal whatever the department; a step with no target tells its own owners', async () => {
    const w = await world();
    await setChain(w, [
      { label: 'Clerk check', role: 'CLERK', slaHours: 4 }, // no escalateTo
      { label: 'HOD review', role: 'HOD', canReject: true, slaHours: 6, escalateTo: 'PRINCIPAL' },
    ]);
    const id = await submit(w);
    let r = await getReq(id);
    await sla.scan({ now: new Date(r.slaDueAt.getTime() + 1000) });
    expect((await byType('SLA_ESCALATION')).map((n) => String(n.userId))).toEqual([String(w.clerk._id)]); // its own owners

    await patch(w.a.clerk, id, 'advance');
    r = await getReq(id);
    await sla.scan({ now: new Date(r.slaDueAt.getTime() + 1000) });
    const toPrincipal = (await byType('SLA_ESCALATION')).filter((n) => String(n.userId) === String(w.principal._id));
    expect(toPrincipal).toHaveLength(1);
    expect((await byType('SLA_ESCALATION')).filter((n) => [String(w.hod._id), String(w.hodMe._id), String(w.clerkMe._id)].includes(String(n.userId)))).toHaveLength(0);
  });

  test('several scanners at the same moment still produce exactly one reminder and one escalation', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const r = await getReq(id);
    const reports = await Promise.all([1, 2, 3].map(() => sla.scan({ now: new Date(r.slaReminderAt.getTime() + 1000) })));
    expect(reports.reduce((n, x) => n + x.reminders, 0)).toBe(1);
    expect(await byType('SLA_REMINDER')).toHaveLength(1);
    const more = await Promise.all([1, 2, 3].map(() => sla.scan({ now: new Date(r.slaDueAt.getTime() + 1000) })));
    expect(more.reduce((n, x) => n + x.escalations, 0)).toBe(1);
    expect(await byType('SLA_ESCALATION')).toHaveLength(1);
  });

  test('moving on resets the notifications: the next step gets its own reminder and escalation', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    await patch(w.a.clerk, id, 'advance');
    const r = await getReq(id);
    await sla.scan({ now: new Date(r.slaDueAt.getTime() + 1000) });
    // The HOD step's escalation goes to the Principal; the earlier Clerk step produced nothing.
    expect((await byType('SLA_ESCALATION')).map((n) => String(n.userId))).toEqual([String(w.principal._id)]);
    expect(await byType('SLA_REMINDER')).toHaveLength(0);
  });

  test('finished requests and stale timers are never processed', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    await patch(w.a.clerk, id, 'advance');
    await patch(w.a.hod, id, 'advance'); // APPROVED
    await runUnscoped(() => Request.updateOne({ _id: id }, { slaDueAt: new Date(Date.now() - HOUR), slaReminderAt: new Date(Date.now() - 2 * HOUR) }));
    expect(await sla.scan({ now: new Date() })).toEqual({ reminders: 0, escalations: 0 });
    expect(await byType('SLA_ESCALATION')).toHaveLength(0);
  });

  test('a request keeps the SLA of the chain version it started with', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const r = await getReq(id);
    // A new version with a very different SLA and escalation target.
    await setChain(w, [{ label: 'Clerk check', role: 'CLERK', slaHours: 1, escalateTo: 'PRINCIPAL' }, { label: 'HOD review', role: 'HOD', canReject: true }]);
    await sla.scan({ now: new Date(r.slaDueAt.getTime() + 1000) }); // the stored timers still say 8 h
    expect((await byType('SLA_ESCALATION')).map((n) => String(n.userId))).toEqual([String(w.hod._id)]); // v1's target, not the Principal
  });

  test('the worker pass includes the SLA scan and delivers the mails', async () => {
    const w = await world();
    await setChain(w);
    const id = await submit(w);
    const r = await getReq(id);
    await worker.runOnce(); // delivers the "submitted" mail, nothing due yet
    const report = await worker.runOnce({ now: new Date(r.slaReminderAt.getTime() + 1000) });
    expect(report).toMatchObject({ reminders: 1, escalations: 0 });
    const next = await worker.runOnce({ now: new Date(r.slaReminderAt.getTime() + 2000) });
    expect(next).toMatchObject({ sent: 1, reminders: 0 });
    expect(mailer.lastTo(w.clerk.email, 'sla-reminder')).not.toBeNull();
  });
});

describe('SLA across institutions', () => {
  test('one scan serves every institution, each inside its own boundaries', async () => {
    const B = await makeTenant('beta-college', 'Beta College');
    const a = await world();
    const b = await world(B, 'beta-college');
    await setChain(a);
    await setChain(b, [{ label: 'Quick check', role: 'CLERK', slaHours: 2, escalateTo: 'HOD' }, { label: 'HOD review', role: 'HOD', canReject: true }]);
    const idA = await submit(a);
    const idB = (await post(b.a.student, '/api/requests', BODY)).body.data.request._id;
    const rA = await getReq(idA);
    const rB = await getReq(idB);
    expect(rB.slaDueAt.getTime() - rB.stepEnteredAt.getTime()).toBe(2 * HOUR); // B's own chain, not A's

    const far = new Date(Math.max(rA.slaDueAt.getTime(), rB.slaDueAt.getTime()) + HOUR);
    expect(await sla.scan({ now: far })).toEqual({ reminders: 0, escalations: 2 });
    const esc = await byType('SLA_ESCALATION');
    expect(esc.map((n) => String(n.userId)).sort()).toEqual([String(a.hod._id), String(b.hod._id)].sort());
    for (const n of esc) {
      const owner = [a.hod, b.hod].find((u) => String(u._id) === String(n.userId));
      expect(String(n.tenantId)).toBe(String(owner.tenantId)); // each notice stays in its own institution
      expect(String(n.requestId)).toBe(String(owner === a.hod ? idA : idB));
    }
    await worker.runOnce({ now: far });
    expect(mailer.lastTo(b.hod.email, 'sla-escalation').message.text).toContain('Beta College');
    expect(mailer.lastTo(a.hod.email, 'sla-escalation').message.text).not.toContain('Beta College');
    void request;
  });
});
