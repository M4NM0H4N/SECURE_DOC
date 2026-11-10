'use strict';

// S5 gate: a request lifecycle produces the expected notifications exactly once each, delivery
// retries survive a provider failure, and nothing crosses institutions or leaks a secret.
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, forgeToken, request, makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const config = require('../config/env');
const mailer = require('../services/mailer');
const worker = require('../services/notificationWorker');
const auditService = require('../services/auditService');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Request = require('../models/Request');
const Invite = require('../models/Invite');
const AuditLog = require('../models/AuditLog');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Notification.collection.deleteMany({});
  await Invite.collection.deleteMany({});
  mailer.clearOutbox();
  config.mailProvider = 'outbox';
});
afterEach(() => {
  jest.restoreAllMocks();
  config.mailProvider = 'outbox';
});

const PDF = Buffer.from('%PDF-1.4\n% notification test\n%%EOF\n');
const BODY = { documentType: 'Transcript', purpose: 'Needed for a visa application' };
const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const patch = (agent, id, action, body) => agent.patch(`/api/requests/${id}/${action}`).set(CSRF).send(body || {});
const rows = (filter) => runUnscoped(() => Notification.find(filter).lean());
const mine = (user, channel) => rows({ userId: user._id, ...(channel ? { channel } : {}) });
const types = async (user, channel = 'IN_APP') => (await mine(user, channel)).map((n) => n.type).sort();

// One institution with the usual cast, plus extras that must NOT be notified.
async function world(tenant, slug) {
  const t = tenant ? { tenant } : {};
  const u = {
    student: await createUser({ role: 'STUDENT', department: 'CSE', ...t }),
    c1: await createUser({ role: 'CLERK', department: 'CSE', ...t }),
    c2: await createUser({ role: 'CLERK', department: 'CSE', ...t }),
    cInactive: await createUser({ role: 'CLERK', department: 'CSE', isActive: false, ...t }),
    cMe: await createUser({ role: 'CLERK', department: 'ME', ...t }),
    h1: await createUser({ role: 'HOD', department: 'CSE', ...t }),
    hMe: await createUser({ role: 'HOD', department: 'ME', ...t }),
    principal: await createUser({ role: 'PRINCIPAL', department: null, ...t }),
    admin: await createUser({ role: 'ADMIN', ...t }),
  };
  const a = {};
  for (const [k, user] of Object.entries(u)) if (user.isActive) a[k] = await loginAgent(app, user, 'Passw0rdTest', slug);
  return { ...u, a };
}
const submit = async (w) => (await post(w.a.student, '/api/requests', BODY)).body.data.request._id;

describe('a request lifecycle notifies the right people, once each', () => {
  test('submitted, step by step, approved, fulfilled: exactly the expected messages and no duplicates', async () => {
    const w = await world();
    const id = await submit(w);

    // Submitted: only the active Clerks of the request's department (step 1), nobody else.
    expect(await types(w.c1)).toEqual(['REQUEST_SUBMITTED']);
    expect(await types(w.c2)).toEqual(['REQUEST_SUBMITTED']);
    for (const none of ['cInactive', 'cMe', 'h1', 'hMe', 'principal', 'admin', 'student']) expect([none, await types(w[none])]).toEqual([none, []]);
    expect(await types(w.c1, 'EMAIL')).toEqual(['REQUEST_SUBMITTED']);

    // The worker delivers each e-mail once; running it again sends nothing more.
    expect(await worker.runOnce()).toMatchObject({ sent: 2, failed: 0 });
    expect(mailer.sent().map((m) => m.to).sort()).toEqual([w.c1.email, w.c2.email].sort());
    expect(mailer.sent()[0].template).toBe('request-submitted');
    expect(mailer.sent()[0].message.text).toContain(`/t/default/request.html?id=${id}`);
    expect(await worker.runOnce()).toMatchObject({ sent: 0 });
    expect(mailer.sent()).toHaveLength(2);

    // Clerk completes step 1: the HOD of that department is told, not the other department's HOD.
    expect((await patch(w.a.c1, id, 'advance')).status).toBe(200);
    expect(await types(w.h1)).toEqual(['STEP_WAITING']);
    expect(await types(w.hMe)).toEqual([]);
    expect(await worker.runOnce()).toMatchObject({ sent: 1 });

    // HOD approves: the student is told, and the Clerks are asked to upload.
    expect((await patch(w.a.h1, id, 'advance')).status).toBe(200);
    expect(await types(w.student)).toEqual(['REQUEST_APPROVED']);
    expect(await types(w.c1)).toEqual(['APPROVED_UPLOAD', 'REQUEST_SUBMITTED']);
    expect(await types(w.c2)).toEqual(['APPROVED_UPLOAD', 'REQUEST_SUBMITTED']);
    expect(await types(w.cMe)).toEqual([]);

    // Upload fulfils: the student is told.
    expect((await w.a.c1.post(`/api/requests/${id}/document`).set(CSRF).attach('document', PDF, { filename: 'a.pdf' })).status).toBe(200);
    expect(await types(w.student)).toEqual(['REQUEST_APPROVED', 'REQUEST_FULFILLED']);
    await worker.runOnce();
    await worker.runOnce();

    // Every (person, type, channel) exists exactly once, and every e-mail went out exactly once.
    const all = await rows({});
    const keys = all.map((n) => `${n.userId}|${n.type}|${n.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(all.filter((n) => n.channel === 'EMAIL').every((n) => n.status === 'SENT' && n.attempts === 1)).toBe(true);
    expect(mailer.sent()).toHaveLength(all.filter((n) => n.channel === 'EMAIL').length);
    const approvedMail = mailer.lastTo(w.student.email, 'request-approved');
    expect(approvedMail.message.subject).toContain('approved');
    expect(approvedMail.message.text).toContain('Default Institution');
  });

  test('rejection carries the reason in the e-mail; questions and answers each notify, once per round', async () => {
    const w = await world();
    const id = await submit(w);
    await patch(w.a.c1, id, 'advance');
    expect((await patch(w.a.h1, id, 'reject', { reason: 'Outstanding fees must be cleared' })).status).toBe(200);
    const rej = (await mine(w.student, 'IN_APP')).find((n) => n.type === 'REQUEST_REJECTED');
    expect(rej.body).not.toContain('Outstanding fees'); // the in-app line stays short; the reason is in the request
    await worker.runOnce();
    expect(mailer.lastTo(w.student.email, 'request-rejected').message.text).toContain('Outstanding fees must be cleared');

    const id2 = await submit(w);
    await patch(w.a.c1, id2, 'needs-info', { note: 'Please add your roll number' });
    expect(await types(w.student)).toEqual(['NEEDS_INFO', 'REQUEST_REJECTED']);
    await w.a.student.patch(`/api/requests/${id2}/resubmit`).set(CSRF).send({});
    expect((await types(w.c1)).filter((t) => t === 'REQUEST_RESUBMITTED')).toHaveLength(1);
    expect((await types(w.c2)).filter((t) => t === 'REQUEST_RESUBMITTED')).toHaveLength(1);
    // A second question is a new event and notifies again (not swallowed as a duplicate).
    await patch(w.a.c1, id2, 'needs-info', { note: 'And your date of birth' });
    expect((await types(w.student)).filter((t) => t === 'NEEDS_INFO')).toHaveLength(2);
    await worker.runOnce();
    expect(mailer.lastTo(w.student.email, 'request-needs-info').message.text).toContain('And your date of birth');
  });

  test('two HODs approving at once: exactly one wins, and the student is told once', async () => {
    const w = await world();
    const h2 = await createUser({ role: 'HOD', department: 'CSE' });
    const h2Agent = await loginAgent(app, h2);
    const id = await submit(w);
    await patch(w.a.c1, id, 'advance');
    const results = await Promise.all([patch(w.a.h1, id, 'advance'), patch(h2Agent, id, 'advance')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await types(w.student)).toEqual(['REQUEST_APPROVED']);
    expect((await mine(w.student, 'EMAIL')).filter((n) => n.type === 'REQUEST_APPROVED')).toHaveLength(1);
  });

  test('ROLLBACK: if the change fails nothing is queued (notifications share the transaction)', async () => {
    const w = await world();
    const id = await submit(w);
    const before = (await rows({})).length;
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await patch(w.a.c1, id, 'advance')).status).toBe(500);
    expect((await Request.findById(id)).status).toBe('PENDING');
    expect((await rows({})).length).toBe(before);
    expect(await types(w.h1)).toEqual([]);
    // A failed submission queues nothing either.
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await post(w.a.student, '/api/requests', BODY)).status).toBe(500);
    expect((await rows({})).length).toBe(before);
  });
});

describe('writing a notification is idempotent', () => {
  test('doing the same thing twice (a retried job, a repeated call) never produces a second message', async () => {
    const notifications = require('../services/notificationService');
    const w = await world();
    const id = await submit(w);
    const request = await Request.findById(id);
    const definition = await require('../services/workflowService').getById(request.workflowDefinitionId);
    const before = (await rows({})).length;
    await notifications.onSubmitted({ request, definition });
    await notifications.onSubmitted({ request, definition });
    expect((await rows({})).length).toBe(before); // the same event and recipients: nothing new
    await notifications.enqueue({ recipient: w.c1, type: 'X', title: 't', body: 'b', template: 'request-fulfilled', dedupe: 'custom-key' });
    await notifications.enqueue({ recipient: w.c1, type: 'X', title: 't', body: 'b', template: 'request-fulfilled', dedupe: 'custom-key' });
    expect((await rows({ type: 'X' })).map((n) => n.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
  });
});

describe('preferences and switches', () => {
  test('a person can turn their e-mail off: the in-app notice stays, ordinary mail stops, security mail does not', async () => {
    const w = await world();
    expect((await w.a.c1.get('/api/notifications/preferences')).body.data).toEqual({ email: true, mailAvailable: true });
    expect((await w.a.c1.patch('/api/notifications/preferences').set(CSRF).send({ email: 'no' })).status).toBe(400);
    expect((await w.a.c1.patch('/api/notifications/preferences').set(CSRF).send({ email: false })).status).toBe(200);
    expect((await w.a.c1.get('/api/notifications/preferences')).body.data.email).toBe(false);

    await submit(w);
    expect(await types(w.c1)).toEqual(['REQUEST_SUBMITTED']);
    expect(await types(w.c1, 'EMAIL')).toEqual([]);
    expect(await types(w.c2, 'EMAIL')).toEqual(['REQUEST_SUBMITTED']);

    // Password reset is security mail: it ignores the preference.
    await post(request(app), '/api/auth/forgot-password', { email: w.c1.email });
    expect(mailer.lastTo(w.c1.email, 'password-reset')).not.toBeNull();
  });

  test('with mail switched off only the in-app notice exists; nothing is queued to fail later', async () => {
    config.mailProvider = 'none';
    const w = await world();
    await submit(w);
    expect(await types(w.c1)).toEqual(['REQUEST_SUBMITTED']);
    expect(await rows({ channel: 'EMAIL' })).toHaveLength(0);
    expect((await w.a.c1.get('/api/notifications/preferences')).body.data.mailAvailable).toBe(false);
    await post(request(app), '/api/auth/forgot-password', { email: w.c1.email });
    expect(await rows({ type: 'SECURITY_RESET' })).toHaveLength(0);
  });
});

describe('delivery: retries, backoff, crashes and concurrent workers', () => {
  async function oneMail() {
    const w = await world();
    const c2 = w.c2;
    await User.updateOne({ _id: c2._id }, { isActive: false }); // keep exactly one recipient (c1)
    await submit(w);
    const [n] = await rows({ channel: 'EMAIL' });
    return { w, n };
  }
  const state = async (id) => (await runUnscoped(() => Notification.findById(id).lean()));

  test('a provider failure is retried with growing waits, then delivered when it recovers', async () => {
    const { n } = await oneMail();
    const send = jest.spyOn(mailer, 'send').mockRejectedValue(new Error('Mail provider returned 503'));
    const t0 = new Date();

    expect(await worker.runOnce({ now: t0 })).toMatchObject({ sent: 0, retry: 1 });
    let s = await state(n._id);
    expect(s).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Mail provider returned 503' });
    expect(s.notBefore.getTime()).toBe(t0.getTime() + 30 * 1000);
    expect(s.lockedAt).toBeNull();

    // Not due yet: nothing is attempted.
    expect(await worker.runOnce({ now: new Date(t0.getTime() + 10 * 1000) })).toMatchObject({ sent: 0, retry: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    const t1 = new Date(t0.getTime() + 31 * 1000);
    await worker.runOnce({ now: t1 });
    s = await state(n._id);
    expect(s.attempts).toBe(2);
    expect(s.notBefore.getTime()).toBe(t1.getTime() + 2 * 60 * 1000);

    // The provider recovers.
    send.mockResolvedValue({ delivered: true });
    const t2 = new Date(t1.getTime() + 3 * 60 * 1000);
    expect(await worker.runOnce({ now: t2 })).toMatchObject({ sent: 1 });
    expect(await state(n._id)).toMatchObject({ status: 'SENT', attempts: 3, lastError: null });
    expect(send.mock.calls.at(-1)[0].idempotencyKey).toBe(String(n._id)); // a retried send can never duplicate at the provider
  });

  test('after six failed attempts it is FAILED and left alone; an Admin can send it again', async () => {
    const { w, n } = await oneMail();
    jest.spyOn(mailer, 'send').mockRejectedValue(new Error('Mail provider returned 500'));
    let now = new Date();
    const waits = [];
    for (let i = 0; i < 6; i += 1) {
      await worker.runOnce({ now });
      const s = await state(n._id);
      waits.push(s.notBefore.getTime() - now.getTime());
      now = new Date(Math.max(now.getTime(), s.notBefore.getTime()) + 1000);
    }
    expect(waits.slice(0, 5)).toEqual([30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000]);
    expect(await state(n._id)).toMatchObject({ status: 'FAILED', attempts: 6, lastError: 'Mail provider returned 500' });
    expect(await worker.runOnce({ now: new Date(now.getTime() + 10 * 86400000) })).toMatchObject({ sent: 0, retry: 0, failed: 0 });

    jest.restoreAllMocks();
    const admin = w.a.admin;
    expect((await post(admin, `/api/admin/notifications/${n._id}/retry`)).status).toBe(200);
    expect(await state(n._id)).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    expect(await worker.runOnce()).toMatchObject({ sent: 1 });
    expect((await post(admin, `/api/admin/notifications/${n._id}/retry`)).status).toBe(409); // not failed any more
    expect((await AuditLog.findOne({ action: 'NOTIFICATION_RETRIED' })).details).toEqual({ notificationId: String(n._id) });
  });

  test('a crashed worker\'s claim is recovered only after the lock timeout', async () => {
    const { n } = await oneMail();
    const t0 = new Date();
    await runUnscoped(() => Notification.updateOne({ _id: n._id }, { lockedAt: t0, attempts: 1 }));
    expect(await worker.runOnce({ now: new Date(t0.getTime() + 60 * 1000) })).toMatchObject({ sent: 0 }); // still locked
    expect(await worker.runOnce({ now: new Date(t0.getTime() + 6 * 60 * 1000) })).toMatchObject({ sent: 1 });
    expect(await state(n._id)).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  test('two workers at the same time send every message exactly once', async () => {
    const w = await world();
    for (let i = 0; i < 3; i += 1) await submit(w);
    const total = (await rows({ channel: 'EMAIL' })).length;
    expect(total).toBe(6); // 3 requests x 2 clerks
    const send = jest.spyOn(mailer, 'send').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { delivered: true };
    });
    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(a.sent + b.sent).toBe(6);
    expect(send).toHaveBeenCalledTimes(6);
    expect(new Set(send.mock.calls.map((c) => c[0].idempotencyKey)).size).toBe(6);
    expect((await rows({ channel: 'EMAIL' })).every((n) => n.status === 'SENT' && n.attempts === 1)).toBe(true);
  });

  test('the person is looked up when the mail is sent: a changed address is used, a deactivated or opted-out person is skipped', async () => {
    const w = await world();
    await submit(w);
    await User.updateOne({ _id: w.c1._id }, { email: 'new.address@example.com' });
    await User.updateOne({ _id: w.c2._id }, { notifyEmail: false });
    const report = await worker.runOnce();
    expect(report).toMatchObject({ sent: 1, cancelled: 1 });
    expect(mailer.sent().map((m) => m.to)).toEqual(['new.address@example.com']);
    expect((await mine(w.c2, 'EMAIL'))[0].status).toBe('CANCELLED');

    await submit(w);
    await User.updateOne({ _id: w.c1._id }, { isActive: false });
    mailer.clearOutbox();
    expect(await worker.runOnce()).toMatchObject({ sent: 0 });
    expect(mailer.sent()).toHaveLength(0);
  });

  test('stored error text never contains addresses or links', async () => {
    const { n } = await oneMail();
    jest.spyOn(mailer, 'send').mockRejectedValue(new Error('x'.repeat(500)));
    await worker.runOnce();
    expect((await state(n._id)).lastError.length).toBeLessThanOrEqual(200);
    const dump = JSON.stringify(await rows({}));
    expect(dump).not.toMatch(/token=|passwordHash|@example\.com/);
  });
});

describe('in-app notifications API', () => {
  test('a person sees only their own, can filter, page and mark as read', async () => {
    const w = await world();
    await submit(w);
    await submit(w);
    const list = await w.a.c1.get('/api/notifications');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toMatch(/no-store/);
    expect(list.body.data).toMatchObject({ total: 2, unreadCount: 2 });
    expect(list.body.data.items.every((n) => n.channel === 'IN_APP' && String(n.userId) === String(w.c1._id))).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/dedupeKey|lockedAt/);
    expect((await w.a.student.get('/api/notifications')).body.data.total).toBe(0);
    expect((await w.a.h1.get('/api/notifications')).body.data.total).toBe(0);

    expect((await w.a.c1.get('/api/notifications?limit=1&page=2')).body.data.items).toHaveLength(1);
    expect((await w.a.c1.get('/api/notifications?limit=1000')).status).toBe(400);
    expect((await w.a.c1.get('/api/notifications?unread=maybe')).status).toBe(400);

    const first = list.body.data.items[0]._id;
    expect((await post(w.a.c1, `/api/notifications/${first}/read`)).status).toBe(200);
    expect((await w.a.c1.get('/api/notifications?unread=true')).body.data).toMatchObject({ total: 1, unreadCount: 1 });
    // Someone else's notice, an e-mail row and a made-up id are all "not found".
    expect((await post(w.a.c2, `/api/notifications/${first}/read`)).status).toBe(404);
    const mail = (await mine(w.c1, 'EMAIL'))[0];
    expect((await post(w.a.c1, `/api/notifications/${mail._id}/read`)).status).toBe(404);
    expect((await post(w.a.c1, '/api/notifications/64b64b64b64b64b64b64b640/read')).status).toBe(404);
    expect((await post(w.a.c1, '/api/notifications/nope/read')).status).toBe(400);

    expect((await post(w.a.c1, '/api/notifications/read-all')).status).toBe(200);
    expect((await w.a.c1.get('/api/notifications')).body.data.unreadCount).toBe(0);
    expect((await w.a.c2.get('/api/notifications')).body.data.unreadCount).toBe(2); // c2 unaffected
    expect((await request(app).get('/api/notifications')).status).toBe(401);
    expect((await request(app).post('/api/notifications/read-all').set(CSRF)).status).toBe(401);
  });
});

describe('the Admin delivery log', () => {
  test('shows e-mail rows with recipient name and role only, filterable, never content or links', async () => {
    const w = await world();
    await submit(w);
    await worker.runOnce();
    await post(request(app), '/api/auth/forgot-password', { email: w.student.email });
    const log = await w.a.admin.get('/api/admin/notifications?limit=100');
    expect(log.status).toBe(200);
    const items = log.body.data.items;
    expect(items.every((n) => n.channel === 'EMAIL')).toBe(true);
    expect(items.map((n) => n.type).sort()).toEqual(['REQUEST_SUBMITTED', 'REQUEST_SUBMITTED', 'SECURITY_RESET']);
    expect(items.find((n) => n.type === 'REQUEST_SUBMITTED').recipient).toEqual({ name: 'CLERK User', role: 'CLERK' });
    expect(JSON.stringify(log.body)).not.toMatch(/@example\.com|token=|"template"|"title"|"body"|userId|dedupeKey|"payload"/);
    expect((await w.a.admin.get('/api/admin/notifications?type=SECURITY_RESET')).body.data.total).toBe(1);
    expect((await w.a.admin.get('/api/admin/notifications?status=SENT')).body.data.total).toBe(3);
    expect((await w.a.admin.get('/api/admin/notifications?status=FAILED')).body.data.total).toBe(0);
    expect((await w.a.admin.get('/api/admin/notifications?status=BOGUS')).status).toBe(400);
    expect((await w.a.admin.get('/api/admin/notifications?limit=500')).status).toBe(400);
    for (const who of ['student', 'c1', 'h1', 'principal']) {
      expect([who, (await w.a[who].get('/api/admin/notifications')).status]).toEqual([who, 403]);
    }
    expect((await request(app).get('/api/admin/notifications')).status).toBe(401);
  });

  test('retry works only for failed ordinary mail; security mail has nothing to resend', async () => {
    const w = await world();
    await submit(w);
    const [n] = await rows({ channel: 'EMAIL' });
    expect((await post(w.a.admin, `/api/admin/notifications/${n._id}/retry`)).status).toBe(409); // still pending
    await post(request(app), '/api/auth/forgot-password', { email: w.student.email });
    const sec = (await rows({ type: 'SECURITY_RESET' }))[0];
    await runUnscoped(() => Notification.updateOne({ _id: sec._id }, { status: 'FAILED' }));
    expect((await post(w.a.admin, `/api/admin/notifications/${sec._id}/retry`)).status).toBe(409);
    expect((await post(w.a.admin, '/api/admin/notifications/64b64b64b64b64b64b64b640/retry')).status).toBe(404);
    expect((await post(w.a.c1, `/api/admin/notifications/${n._id}/retry`)).status).toBe(403);
  });
});

describe('security mail is delivered, recorded without its link, and never stored', () => {
  test('an invitation mail is sent and logged (no recipient account, no link), and the token appears nowhere in the database', async () => {
    const w = await world();
    const res = await post(w.a.admin, '/api/admin/invites', { email: 'new.staff@example.com', role: 'CLERK', department: 'CSE' });
    expect(res.status).toBe(201);
    const token = new URL(res.body.data.link).searchParams.get('token');
    expect(mailer.lastTo('new.staff@example.com', 'staff-invite').message.text).toContain(token); // delivered to the invitee
    expect(mailer.lastTo('new.staff@example.com', 'staff-invite').message.text).toContain('Default Institution');
    const [row] = await rows({ type: 'SECURITY_INVITE' });
    expect(row).toMatchObject({ channel: 'EMAIL', status: 'SENT', userId: null, template: null });
    expect(JSON.stringify(await Notification.collection.find({}).toArray())).not.toContain(token);
  });

  test('a provider failure is retried once and recorded as FAILED; the invitation itself still succeeds', async () => {
    const w = await world();
    const send = jest.spyOn(mailer, 'send').mockRejectedValue(new Error('Mail provider returned 503'));
    const res = await post(w.a.admin, '/api/admin/invites', { email: 'new.staff@example.com', role: 'HOD', department: 'CSE' });
    expect(res.status).toBe(201);
    expect(res.body.data.link).toContain('accept-invite.html'); // the Admin still has the link to pass on
    expect(send).toHaveBeenCalledTimes(2);
    const [row] = await rows({ type: 'SECURITY_INVITE' });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 2, lastError: 'Mail provider returned 503' });
    expect(JSON.stringify(row)).not.toContain('token=');
  });

  test('reset and verification mail record the recipient but not the link', async () => {
    const w = await world();
    await post(request(app), '/api/auth/forgot-password', { email: w.student.email });
    await post(request(app), '/api/auth/register', { name: 'New Student', email: 'new.student@example.com', password: 'Passw0rdTest', department: 'CSE' });
    const reset = (await rows({ type: 'SECURITY_RESET' }))[0];
    const verify = (await rows({ type: 'SECURITY_VERIFY' }))[0];
    expect(String(reset.userId)).toBe(String(w.student._id));
    expect(verify.status).toBe('SENT');
    expect(JSON.stringify(await rows({}))).not.toMatch(/token=|reset-password\.html|verify-email\.html/);
  });
});

describe('tenant isolation of notifications and delivery', () => {
  test('each institution notifies only its own people, with its own name and links; nothing crosses', async () => {
    const B = await makeTenant('beta-college', 'Beta College');
    const a = await world();
    const b = await world(B, 'beta-college');
    await submit(a);
    const idB = (await post(b.a.student, '/api/requests', BODY)).body.data.request._id;

    for (const person of ['c1', 'c2']) {
      expect((await rows({ userId: a[person]._id })).every((n) => String(n.tenantId) === String(getDefaultTenant()._id))).toBe(true);
      expect((await rows({ userId: b[person]._id })).every((n) => String(n.tenantId) === String(B._id))).toBe(true);
    }
    expect(await types(a.c1)).toEqual(['REQUEST_SUBMITTED']);
    expect(await types(b.c1)).toEqual(['REQUEST_SUBMITTED']);

    await worker.runOnce();
    const toB = mailer.lastTo(b.c1.email, 'request-submitted');
    expect(toB.message.text).toContain('Beta College');
    expect(toB.message.text).toContain(`/t/beta-college/request.html?id=${idB}`);
    expect(toB.message.text).not.toContain('Default Institution');
    expect(mailer.lastTo(a.c1.email, 'request-submitted').message.text).toContain('/t/default/request.html');

    // Reading and administering: only your own institution.
    expect((await a.a.c1.get('/api/notifications')).body.data.total).toBe(1);
    expect((await b.a.c1.get('/api/notifications')).body.data.total).toBe(1);
    const bNote = (await rows({ userId: b.c1._id, channel: 'IN_APP' }))[0];
    expect((await post(a.a.c1, `/api/notifications/${bNote._id}/read`)).status).toBe(404);
    expect((await runUnscoped(() => Notification.findById(bNote._id))).readAt).toBeNull();
    const aLog = await a.a.admin.get('/api/admin/notifications?limit=100');
    expect(aLog.body.data.total).toBe(2);
    const bMail = (await rows({ userId: b.c1._id, channel: 'EMAIL' }))[0];
    await runUnscoped(() => Notification.updateOne({ _id: bMail._id }, { status: 'FAILED' }));
    expect((await post(a.a.admin, `/api/admin/notifications/${bMail._id}/retry`)).status).toBe(404);
    expect((await runUnscoped(() => Notification.findById(bMail._id))).status).toBe('FAILED');

    // A session from one institution is useless at the other, on every new route.
    const token = forgeToken(a.c1._id);
    for (const [method, url] of [['get', '/api/notifications'], ['post', '/api/notifications/read-all'], ['get', '/api/notifications/preferences'], ['patch', '/api/notifications/preferences'], ['get', '/api/admin/notifications'], ['post', `/api/admin/notifications/${bMail._id}/retry`]]) {
      const res = await request(app, 'beta-college')[method](url).set(CSRF).set('Cookie', `${config.cookieName}=${token}`).send({});
      expect([url, res.status]).toEqual([url, 401]);
    }
    void runAsTenant;
    void crypto;
    void createRequest;
  });
});
