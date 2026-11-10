'use strict';

// S7: API keys, the read-only v1 API, outgoing signed webhooks (retries, SSRF protection) and
// isolation between institutions.
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, forgeToken, request, makeTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const { startFakeReceiver } = require('./fakes');
const config = require('../config/env');
const worker = require('../services/notificationWorker');
const webhooks = require('../services/webhookService');
const auditService = require('../services/auditService');
const { isPrivateAddress } = require('../utils/netguard');
const ApiKey = require('../models/ApiKey');
const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const AuditLog = require('../models/AuditLog');
const Request = require('../models/Request');
const Notification = require('../models/Notification');
const { buildSpec } = require('../openapi');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Notification.collection.deleteMany({});
  await ApiKey.collection.deleteMany({});
  await Webhook.collection.deleteMany({});
  await WebhookDelivery.collection.deleteMany({});
  config.webhookAllowPrivate = false;
  config.webhookKey = process.env.WEBHOOK_ENCRYPTION_KEY;
});
afterEach(() => {
  jest.restoreAllMocks();
  config.webhookAllowPrivate = false;
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const patch = (agent, id, action, body) => agent.patch(`/api/requests/${id}/${action}`).set(CSRF).send(body || {});
const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const v1 = (key, path, slug) => request(app, slug).get(`/api/t/${slug || 'default'}/v1${path}`).set(bearer(key));
const rawGet = (slug, path, headers = {}) => require('supertest')(app).get(`/api/t/${slug}/v1${path}`).set(headers);

async function world(tenant, slug) {
  const t = tenant ? { tenant } : {};
  const u = {
    admin: await createUser({ role: 'ADMIN', ...t }),
    student: await createUser({ role: 'STUDENT', department: 'CSE', ...t }),
    clerk: await createUser({ role: 'CLERK', department: 'CSE', ...t }),
    hod: await createUser({ role: 'HOD', department: 'CSE', ...t }),
  };
  const a = {};
  for (const [k, user] of Object.entries(u)) a[k] = await loginAgent(app, user, 'Passw0rdTest', slug);
  return { ...u, a };
}
async function makeKey(w, scopes = ['requests:read', 'analytics:read'], extra = {}) {
  const res = await post(w.a.admin, '/api/admin/api-keys', { name: 'Integration', scopes, ...extra });
  expect(res.status).toBe(201);
  return { secret: res.body.data.secret, id: res.body.data.key._id };
}

describe('API keys', () => {
  test('the full key is shown once; only a prefix and a hash are stored; the list never shows it', async () => {
    const w = await world();
    const res = await post(w.a.admin, '/api/admin/api-keys', { name: 'Library system', scopes: ['requests:read'] });
    expect(res.status).toBe(201);
    const { secret, key } = res.body.data;
    expect(secret).toMatch(/^dfk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ name: 'Library system', scopes: ['requests:read'], status: 'ACTIVE', revokedAt: null });
    const stored = await ApiKey.findOne({}).select('+secretHash');
    expect(stored.prefix).toBe(secret.split('_')[1]);
    expect(stored.secretHash).toBe(sha(secret.slice(13)));
    expect(JSON.stringify(await ApiKey.collection.find({}).toArray())).not.toContain(secret.slice(13));
    const list = await w.a.admin.get('/api/admin/api-keys');
    expect(JSON.stringify(list.body)).not.toMatch(/secretHash|dfk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/);
    expect(list.body.data.items).toHaveLength(1);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toContain(secret.slice(13));
    expect((await AuditLog.findOne({ action: 'API_KEY_CREATED' })).details).toEqual({ keyId: String(key._id), scopes: ['requests:read'] });
  });

  test('input rules: scopes, name, expiry, at most ten active keys, admin only', async () => {
    const w = await world();
    for (const body of [{ name: 'x', scopes: ['requests:read'] }, { name: 'Valid name', scopes: [] }, { name: 'Valid name', scopes: ['requests:write'] }, { name: 'Valid name', scopes: ['documents:read'] }, { name: 'Valid name', scopes: 'requests:read' }, { name: 'Valid name', scopes: ['requests:read'], expiresInDays: 0 }, { name: 'Valid name', scopes: ['requests:read'], expiresInDays: 9999 }, { scopes: ['requests:read'] }]) {
      expect([JSON.stringify(body), (await post(w.a.admin, '/api/admin/api-keys', body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    const withExpiry = await post(w.a.admin, '/api/admin/api-keys', { name: 'Short lived', scopes: ['requests:read'], expiresInDays: 30 });
    expect(new Date(withExpiry.body.data.key.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    for (let i = 0; i < 9; i += 1) await makeKey(w, ['requests:read']);
    const eleventh = await post(w.a.admin, '/api/admin/api-keys', { name: 'One too many', scopes: ['requests:read'] });
    expect(eleventh.status).toBe(409);
    for (const who of ['student', 'clerk', 'hod']) expect([who, (await post(w.a[who], '/api/admin/api-keys', { name: 'Sneaky key', scopes: ['requests:read'] })).status]).toEqual([who, 403]);
    expect((await request(app).get('/api/admin/api-keys')).status).toBe(401);
  });

  test('revoking works at once, frees a slot, and cannot be done twice', async () => {
    const w = await world();
    const k = await makeKey(w);
    expect((await v1(k.secret, '/requests')).status).toBe(200);
    expect((await w.a.admin.delete(`/api/admin/api-keys/${k.id}`).set(CSRF)).status).toBe(200);
    expect((await v1(k.secret, '/requests')).status).toBe(401);
    expect((await w.a.admin.delete(`/api/admin/api-keys/${k.id}`).set(CSRF)).status).toBe(404);
    expect((await w.a.admin.get('/api/admin/api-keys')).body.data.items[0].status).toBe('REVOKED');
    expect((await w.a.admin.delete('/api/admin/api-keys/nope').set(CSRF)).status).toBe(400);
  });
});

describe('the read-only v1 API', () => {
  test('missing, malformed, wrong, revoked, expired and cookie-only credentials all get the same 401', async () => {
    const w = await world();
    const good = await makeKey(w);
    const prefix = good.secret.slice(4, 12);
    const secret = good.secret.slice(13);
    const expired = await makeKey(w, ['requests:read']);
    await ApiKey.updateOne({ _id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await makeKey(w, ['requests:read']);
    await w.a.admin.delete(`/api/admin/api-keys/${revoked.id}`).set(CSRF);

    const attempts = [
      {}, bearer('nonsense'), bearer(`dfk_${prefix}_${'A'.repeat(43)}`), bearer(`dfk_zzzzzzzz_${secret}`), bearer(`dfk_${prefix}_${secret}x`),
      bearer(expired.secret), bearer(revoked.secret), { Authorization: `Basic ${good.secret}` }, { Authorization: '' },
    ];
    const messages = new Set();
    for (const h of attempts) {
      const res = await rawGet('default', '/requests', h);
      expect([JSON.stringify(h).slice(0, 40), res.status]).toEqual([JSON.stringify(h).slice(0, 40), 401]);
      messages.add(res.body.message);
    }
    expect([...messages]).toEqual(['Invalid or missing API key']);
    // A signed-in browser session is not an API credential.
    expect((await require('supertest')(app).get('/api/v1/requests')).status).toBe(404); // not even a route without the tenant
    expect((await w.a.admin.get('/api/t/default/v1/requests')).status).toBe(401);
    expect((await rawGet('default', '/requests', bearer(good.secret))).status).toBe(200);
  });

  test('scopes are enforced per route (403), and use is recorded', async () => {
    const w = await world();
    const onlyRequests = await makeKey(w, ['requests:read']);
    const onlyAnalytics = await makeKey(w, ['analytics:read']);
    expect((await v1(onlyRequests.secret, '/requests')).status).toBe(200);
    expect((await v1(onlyRequests.secret, '/analytics/summary')).status).toBe(403);
    expect((await v1(onlyAnalytics.secret, '/analytics/summary')).status).toBe(200);
    const denied = await v1(onlyAnalytics.secret, '/requests');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('requests:read');
    expect((await ApiKey.findById(onlyRequests.id)).lastUsedAt).toBeTruthy();
  });

  test('responses hold ids, types, statuses, steps and times only: no names, purposes, staff or notes', async () => {
    const w = await world();
    const k = await makeKey(w);
    const id = (await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Highly personal purpose text' })).body.data.request._id;
    await patch(w.a.clerk, id, 'needs-info', { note: 'Please send your private roll number' });
    await w.a.student.patch(`/api/requests/${id}/resubmit`).set(CSRF).send({});
    await patch(w.a.clerk, id, 'advance');

    const list = await v1(k.secret, '/requests');
    const one = await v1(k.secret, `/requests/${id}`);
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);
    for (const res of [list, one]) {
      expect(res.headers['cache-control']).toMatch(/no-store/);
      const dump = JSON.stringify(res.body);
      expect(dump).not.toMatch(new RegExp(`Highly personal|private roll|${w.student.email}|${w.clerk.email}|STUDENT User|CLERK User|"by"|"note"|"purpose"|studentId|passwordHash`));
    }
    expect(list.body.data.items[0]).toMatchObject({ id, documentType: 'Transcript', department: 'CSE', status: 'UNDER_REVIEW', currentStep: 'HOD decision', fulfilledAt: null });
    expect(one.body.data.request.history.map((h) => h.status)).toEqual(['PENDING', 'NEEDS_INFO', 'PENDING', 'UNDER_REVIEW']);
    expect(Object.keys(one.body.data.request.history[0]).sort()).toEqual(['at', 'status', 'step']);
  });

  test('filters, search (document type only), sort and pagination work; bad input is 400; unknown or foreign ids are 404', async () => {
    const w = await world();
    const k = await makeKey(w);
    await createRequest(w.student, { status: 'PENDING', documentType: 'Transcript', purpose: 'alpha secret purpose' });
    await createRequest(w.student, { status: 'FULFILLED', documentType: 'Fee Receipt', purpose: 'beta purpose text' });
    await createRequest(w.student, { status: 'PENDING', documentType: 'Bonafide Certificate', purpose: 'gamma purpose text' });
    const total = (qs) => v1(k.secret, `/requests?${qs}`).then((r) => r.body.data.total);
    expect(await total('')).toBe(3);
    expect(await total('status=PENDING')).toBe(2);
    expect(await total('documentType=Transcript')).toBe(1);
    expect(await total('q=fee')).toBe(1);
    expect(await total('q=secret')).toBe(0); // purposes are personal text: never searched
    expect(await total('department=cse')).toBe(3);
    expect(await total('department=ME')).toBe(0);
    const page = (await v1(k.secret, '/requests?limit=2&page=2&sort=documentType&order=asc')).body.data;
    expect(page.items).toHaveLength(1);
    expect(page).toMatchObject({ total: 3, page: 2, limit: 2 });
    for (const qs of ['status=BOGUS', 'limit=101', 'sort=purpose', 'from=never']) expect([qs, (await v1(k.secret, `/requests?${qs}`)).status]).toEqual([qs, 400]);
    expect((await v1(k.secret, '/requests/nope')).status).toBe(400);
    expect((await v1(k.secret, '/requests/64b64b64b64b64b64b64b640')).status).toBe(404);
  });

  test('each key is rate limited on its own', async () => {
    const w = await world();
    const k1 = await makeKey(w);
    const k2 = await makeKey(w);
    const small = makeApp({ authRateLimitMax: 1000, apiKeyRateLimitMax: 3 });
    const call = (k) => require('supertest')(small).get('/api/t/default/v1/requests').set(bearer(k.secret));
    for (let i = 0; i < 3; i += 1) expect((await call(k1)).status).toBe(200);
    const limited = await call(k1);
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/API key/);
    expect((await call(k2)).status).toBe(200); // another key is unaffected
  });

  test('the description is public and is the same contract the tests use', async () => {
    const res = await rawGet('default', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(buildSpec())));
    expect(res.body.paths['/v1/requests'].get.operationId).toBe('listRequests');
  });

  test('isolation: a key only works for its own institution, and sees only its own data', async () => {
    const B = await makeTenant('beta-college');
    const a = await world();
    const b = await world(B, 'beta-college');
    const ka = await makeKey(a);
    const kb = await makeKey(b);
    const idA = (await post(a.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'A purpose here' })).body.data.request._id;
    const idB = (await post(b.a.student, '/api/requests', { documentType: 'Fee Receipt', purpose: 'B purpose here' })).body.data.request._id;

    expect((await v1(ka.secret, '/requests')).body.data.items.map((r) => r.id)).toEqual([idA]);
    expect((await v1(kb.secret, '/requests', 'beta-college')).body.data.items.map((r) => r.id)).toEqual([idB]);
    expect((await v1(ka.secret, '/requests', 'beta-college')).status).toBe(401); // A's key at B's address
    expect((await v1(kb.secret, '/requests')).status).toBe(401);
    expect((await v1(ka.secret, `/requests/${idB}`)).status).toBe(404);
    expect((await v1(ka.secret, '/analytics/summary')).body.data.total).toBe(1);

    // Managing keys: A's Admin cannot see or revoke B's keys.
    expect((await a.a.admin.get('/api/admin/api-keys')).body.data.items.map((k) => k._id)).toEqual([ka.id]);
    expect((await a.a.admin.delete(`/api/admin/api-keys/${kb.id}`).set(CSRF)).status).toBe(404);
    expect((await v1(kb.secret, '/requests', 'beta-college')).status).toBe(200);
    const token = forgeToken(a.admin._id);
    expect((await request(app, 'beta-college').get('/api/admin/api-keys').set('Cookie', `${config.cookieName}=${token}`)).status).toBe(401);
    void runAsTenant;
  });
});

describe('network safety (unit)', () => {
  test.each([
    ['127.0.0.1', true], ['127.1.2.3', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true], ['192.168.1.1', true], ['169.254.169.254', true],
    ['100.64.0.1', true], ['0.0.0.0', true], ['224.0.0.1', true], ['255.255.255.255', true], ['::1', true], ['::', true], ['fe80::1', true], ['fc00::1', true], ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:10.0.0.1', true], ['not-an-ip', true], ['', true],
    ['8.8.8.8', false], ['1.1.1.1', false], ['172.32.0.1', false], ['93.184.216.34', false], ['2606:4700:4700::1111', false], ['::ffff:8.8.8.8', false],
  ])('(unit) %s is private: %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('webhook management', () => {
  const create = (agent, over = {}) => post(agent, '/api/admin/webhooks', { name: 'Library', url: 'https://hooks.example.com/docflow', events: ['request.status_changed'], ...over });

  test('the signing secret is shown once and stored encrypted; the list never shows it', async () => {
    const w = await world();
    const res = await create(w.a.admin);
    expect(res.status).toBe(201);
    const { secret, webhook } = res.body.data;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(webhook)).not.toMatch(/secretEnc|whsec_/);
    const row = await Webhook.findOne({}).select('+secretEnc');
    expect(row.secretEnc).not.toContain(secret);
    expect(webhooks.decrypt(row.secretEnc)).toBe(secret);
    expect(JSON.stringify((await w.a.admin.get('/api/admin/webhooks')).body)).not.toMatch(/whsec_|secretEnc/);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toMatch(/whsec_|hooks\.example\.com/);
    const rotated = (await post(w.a.admin, `/api/admin/webhooks/${webhook._id}/rotate-secret`)).body.data.secret;
    expect(rotated).not.toBe(secret);
    expect(webhooks.decrypt((await Webhook.findOne({}).select('+secretEnc')).secretEnc)).toBe(rotated);
  });

  test('SECURITY: the URL must be https and public: no credentials, localhost, internal names or private addresses', async () => {
    const w = await world();
    for (const url of [
      'http://hooks.example.com/x', 'ftp://hooks.example.com/x', 'not a url', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com/x#frag',
      'https://localhost/x', 'https://app.localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x',
      'https://192.168.0.10/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://0.0.0.0/x',
    ]) {
      const res = await create(w.a.admin, { url });
      expect([url, res.status]).toEqual([url, 400]);
    }
    expect((await create(w.a.admin, { url: 'https://hooks.example.com/docflow?team=a' })).status).toBe(201);
    expect(await Webhook.countDocuments({})).toBe(1);
  });

  test('events, names, the ten-webhook cap, switching off, deleting and admin-only access', async () => {
    const w = await world();
    for (const body of [{ events: [] }, { events: ['nope'] }, { events: ['ping'] }, { events: 'request.submitted' }, { name: 'x' }]) {
      expect([JSON.stringify(body), (await create(w.a.admin, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    const hook = (await create(w.a.admin)).body.data.webhook;
    expect((await w.a.admin.patch(`/api/admin/webhooks/${hook._id}`).set(CSRF).send({ active: 'no' })).status).toBe(400);
    expect((await w.a.admin.patch(`/api/admin/webhooks/${hook._id}`).set(CSRF).send({ active: false, events: ['request.submitted', 'document.issued'] })).body.data.webhook).toMatchObject({ active: false, events: ['request.submitted', 'document.issued'] });
    expect((await w.a.admin.patch(`/api/admin/webhooks/${hook._id}`).set(CSRF).send({ url: 'http://insecure.example.com' })).status).toBe(400);
    for (let i = 0; i < 9; i += 1) await create(w.a.admin, { name: `Hook ${i}` });
    expect((await create(w.a.admin, { name: 'Eleventh' })).status).toBe(409);
    for (const who of ['student', 'clerk', 'hod']) expect([who, (await create(w.a[who])).status]).toEqual([who, 403]);
    expect((await w.a.admin.delete(`/api/admin/webhooks/${hook._id}`).set(CSRF)).status).toBe(200);
    expect((await w.a.admin.delete(`/api/admin/webhooks/${hook._id}`).set(CSRF)).status).toBe(404);
    config.webhookKey = '';
    expect((await create(w.a.admin)).status).toBe(503);
    expect((await w.a.admin.get('/api/admin/webhooks')).body.data.available).toBe(false);
  });

  test('isolation: another institution\'s Admin can neither see nor change a webhook', async () => {
    const B = await makeTenant('beta-college');
    const a = await world();
    const b = await world(B, 'beta-college');
    const hook = (await create(a.a.admin)).body.data.webhook;
    expect((await b.a.admin.get('/api/admin/webhooks')).body.data.items).toHaveLength(0);
    for (const [method, url, body] of [['patch', `/api/admin/webhooks/${hook._id}`, { active: false }], ['delete', `/api/admin/webhooks/${hook._id}`], ['post', `/api/admin/webhooks/${hook._id}/ping`], ['post', `/api/admin/webhooks/${hook._id}/rotate-secret`], ['get', `/api/admin/webhooks/${hook._id}/deliveries`]]) {
      const res = await b.a.admin[method](url).set(CSRF).send(body || {});
      expect([url, res.status]).toEqual([url, 404]);
    }
    expect((await Webhook.findById(hook._id)).active).toBe(true);
  });
});

describe('webhook delivery', () => {
  let receiver;
  beforeEach(async () => {
    receiver = await startFakeReceiver();
    config.webhookAllowPrivate = true; // the fake receiver lives on 127.0.0.1
  });
  afterEach(() => receiver.close());

  async function hook(w, events = ['request.submitted', 'request.status_changed', 'document.issued'], over = {}) {
    const res = await post(w.a.admin, '/api/admin/webhooks', { name: 'Receiver', url: receiver.url, events, ...over });
    expect(res.status).toBe(201);
    return { id: res.body.data.webhook._id, secret: res.body.data.secret };
  }
  const verifySignature = (secret, req) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers['x-docflow-signature']);
    if (!m) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${req.body}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
  };

  test('events are queued with the change, delivered once, signed correctly, and carry ids and statuses only', async () => {
    const w = await world();
    const h = await hook(w);
    const id = (await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Very private purpose' })).body.data.request._id;
    expect(await WebhookDelivery.countDocuments({ status: 'PENDING' })).toBe(1);
    await patch(w.a.clerk, id, 'advance');
    await patch(w.a.hod, id, 'advance');
    await w.a.clerk.post(`/api/requests/${id}/document`).set(CSRF).attach('document', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf' });
    expect(await WebhookDelivery.countDocuments({})).toBe(1 + 2 + 1 + 1 + 0); // submitted, 2 advances, fulfilled, document issued

    await worker.runOnce();
    expect(receiver.state.requests).toHaveLength(5);
    expect(await worker.runOnce()).toMatchObject({ webhooks: { sent: 0 } }); // nothing is sent twice
    expect(receiver.state.requests).toHaveLength(5);

    for (const r of receiver.state.requests) {
      expect(r.method).toBe('POST');
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['x-docflow-event']).toMatch(/^(request\.submitted|request\.status_changed|document\.issued)$/);
      expect(r.headers['x-docflow-delivery']).toMatch(/^[0-9a-f]{24}$/);
      expect(verifySignature(h.secret, r)).toBe(true);
      expect(JSON.parse(r.body)).toMatchObject({ event: r.headers['x-docflow-event'] });
      expect(r.body).not.toMatch(new RegExp(`Very private|${w.student.email}|STUDENT User|purpose|passwordHash`));
    }
    const events = receiver.state.requests.map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.event).sort()).toEqual(['document.issued', 'request.status_changed', 'request.status_changed', 'request.status_changed', 'request.submitted']);
    const approved = events.find((e) => e.event === 'request.status_changed' && e.data.status === 'APPROVED');
    expect(approved.data).toMatchObject({ requestId: id, department: 'CSE', previousStatus: 'UNDER_REVIEW', step: 'HOD decision' });
    expect((await WebhookDelivery.find({}).lean()).every((d) => d.status === 'SENT' && d.attempts === 1 && d.lastStatus === 200)).toBe(true);
    void h;
  });

  test('a wrong secret does not verify, and the signature depends on the body and the time', async () => {
    const w = await world();
    const h = await hook(w);
    await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Some purpose here' });
    await worker.runOnce();
    const r = receiver.state.requests[0];
    expect(verifySignature(h.secret, r)).toBe(true);
    expect(verifySignature('whsec_wrong', r)).toBe(false);
    expect(verifySignature(h.secret, { ...r, body: `${r.body} ` })).toBe(false);
    const rotated = (await post(w.a.admin, `/api/admin/webhooks/${h.id}/rotate-secret`)).body.data.secret;
    await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Another purpose here' });
    await worker.runOnce();
    const r2 = receiver.state.requests.at(-1);
    expect(verifySignature(rotated, r2)).toBe(true);
    expect(verifySignature(h.secret, r2)).toBe(false);
  });

  test('only subscribed events go to a webhook, and a switched-off webhook gets nothing', async () => {
    const w = await world();
    const h = await hook(w, ['request.submitted']);
    const id = (await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Some purpose here' })).body.data.request._id;
    await patch(w.a.clerk, id, 'advance'); // status_changed: not subscribed
    expect(await WebhookDelivery.countDocuments({})).toBe(1);
    await w.a.admin.patch(`/api/admin/webhooks/${h.id}`).set(CSRF).send({ active: false });
    await post(w.a.student, '/api/requests', { documentType: 'Fee Receipt', purpose: 'Some other purpose' });
    expect(await WebhookDelivery.countDocuments({})).toBe(1);
  });

  test('a failing receiver is retried with growing waits, recovers, and gives up after eight attempts', async () => {
    const w = await world();
    const h = await hook(w, ['request.submitted']);
    await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Some purpose here' });
    receiver.state.status = 500;
    const t0 = new Date();
    expect(await webhooks.deliverDue({ now: t0 })).toMatchObject({ retry: 1 });
    let d = await WebhookDelivery.findOne({});
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1, lastStatus: 500, lastError: 'receiver answered 500' });
    expect(d.notBefore.getTime()).toBe(t0.getTime() + 30 * 1000);
    expect(await webhooks.deliverDue({ now: new Date(t0.getTime() + 5000) })).toEqual({ sent: 0, retry: 0, failed: 0 }); // not due
    receiver.state.status = 200;
    expect(await webhooks.deliverDue({ now: new Date(t0.getTime() + 31000) })).toMatchObject({ sent: 1 });
    d = await WebhookDelivery.findOne({});
    expect(d).toMatchObject({ status: 'SENT', attempts: 2 });

    // Eight failures in a row: FAILED. (A redirect is a failure too, and is never followed.)
    await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Second purpose here' });
    receiver.state.status = 302;
    receiver.state.location = 'http://127.0.0.1:1/elsewhere';
    let now = new Date();
    const waits = [];
    for (let i = 0; i < 8; i += 1) {
      await webhooks.deliverDue({ now });
      const row = await WebhookDelivery.findOne({ status: { $in: ['PENDING', 'FAILED'] } });
      waits.push(row.notBefore.getTime() - now.getTime());
      now = new Date(Math.max(now.getTime(), row.notBefore.getTime()) + 1000);
    }
    expect(waits.slice(0, 7)).toEqual([30e3, 120e3, 600e3, 3600e3, 21600e3, 43200e3, 86400e3]);
    expect(await WebhookDelivery.findOne({ status: 'FAILED' })).toMatchObject({ attempts: 8, lastStatus: 302 });
    expect(receiver.state.requests.filter((r) => r.url === '/elsewhere')).toHaveLength(0);
    expect((await Webhook.findById(h.id)).consecutiveFailures).toBe(1);
  });

  test('ten deliveries in a row that give up switch the webhook off; a success resets the count', async () => {
    const w = await world();
    const h = await hook(w, ['request.submitted']);
    receiver.state.status = 500;
    const mk = (i, attempts) => WebhookDelivery.create({ webhookId: h.id, event: 'request.submitted', payload: { event: 'request.submitted', createdAt: new Date().toISOString(), data: { i } }, dedupeKey: `t${i}:${Math.random()}`, attempts });
    for (let i = 0; i < 4; i += 1) await mk(i, 7);
    await webhooks.deliverDue();
    expect((await Webhook.findById(h.id)).consecutiveFailures).toBe(4);
    receiver.state.status = 200;
    await mk('ok', 0);
    await webhooks.deliverDue();
    expect((await Webhook.findById(h.id)).consecutiveFailures).toBe(0); // reset by a success
    receiver.state.status = 500;
    for (let i = 0; i < 10; i += 1) await mk(`f${i}`, 7);
    await webhooks.deliverDue({ limit: 25 });
    const off = await Webhook.findById(h.id);
    expect(off).toMatchObject({ active: false, consecutiveFailures: 10 });
    expect(off.disabledReason).toMatch(/repeated failures/);
    expect((await w.a.admin.patch(`/api/admin/webhooks/${h.id}`).set(CSRF).send({ active: true })).body.data.webhook).toMatchObject({ active: true, consecutiveFailures: 0, disabledReason: null });
  });

  test('SECURITY: a webhook cannot be aimed at a private address at delivery time, even by host name', async () => {
    const w = await world();
    await hook(w, ['request.submitted'], { url: receiver.url.replace('127.0.0.1', 'localhost') }); // accepted only because the dev flag is on
    await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Some purpose here' });
    config.webhookAllowPrivate = false; // production behaviour
    const out = await webhooks.deliverDue();
    expect(out).toMatchObject({ retry: 1 });
    expect(receiver.state.requests).toHaveLength(0); // never connected
    expect((await WebhookDelivery.findOne({})).lastError).toBe('address not allowed');
  });

  test('the Admin can send a test event and look at the delivery history', async () => {
    const w = await world();
    const h = await hook(w, ['request.submitted']);
    expect((await post(w.a.admin, `/api/admin/webhooks/${h.id}/ping`)).status).toBe(200);
    await worker.runOnce();
    const ping = JSON.parse(receiver.state.requests[0].body);
    expect(ping).toMatchObject({ event: 'ping', data: { message: 'Test event from DocFlow' } });
    const history = (await w.a.admin.get(`/api/admin/webhooks/${h.id}/deliveries`)).body.data;
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ event: 'ping', status: 'SENT', attempts: 1, lastStatus: 200 });
    expect(JSON.stringify(history)).not.toMatch(/payload|whsec_|dedupeKey/);
    await w.a.admin.patch(`/api/admin/webhooks/${h.id}`).set(CSRF).send({ active: false });
    expect((await post(w.a.admin, `/api/admin/webhooks/${h.id}/ping`)).status).toBe(409);
  });

  test('exactly once: simultaneous approvals produce one event, and a rolled-back change produces none', async () => {
    const w = await world();
    const hod2 = await createUser({ role: 'HOD', department: 'CSE' });
    const h2 = await loginAgent(app, hod2);
    await hook(w, ['request.status_changed']);
    const id = (await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Some purpose here' })).body.data.request._id;
    await patch(w.a.clerk, id, 'advance');
    const before = await WebhookDelivery.countDocuments({});
    const results = await Promise.all([patch(w.a.hod, id, 'advance'), patch(h2, id, 'advance')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await WebhookDelivery.countDocuments({})).toBe(before + 1);

    const id2 = (await post(w.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Rollback purpose' })).body.data.request._id;
    const count = await WebhookDelivery.countDocuments({});
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await patch(w.a.clerk, id2, 'advance')).status).toBe(500);
    expect(await WebhookDelivery.countDocuments({})).toBe(count);
    expect((await Request.findById(id2)).status).toBe('PENDING');
  });

  test('isolation: each institution\'s events reach only its own webhooks, signed with its own secret', async () => {
    const B = await makeTenant('beta-college');
    const a = await world();
    const b = await world(B, 'beta-college');
    const receiverB = await startFakeReceiver();
    try {
      const ha = await hook(a, ['request.submitted']);
      const rb = await post(b.a.admin, '/api/admin/webhooks', { name: 'B hook', url: receiverB.url, events: ['request.submitted'] });
      const hb = { secret: rb.body.data.secret };
      await post(a.a.student, '/api/requests', { documentType: 'Transcript', purpose: 'Institution A purpose' });
      await post(b.a.student, '/api/requests', { documentType: 'Fee Receipt', purpose: 'Institution B purpose' });
      expect(await WebhookDelivery.countDocuments({})).toBe(1); // the default tenant sees only its own
      await worker.runOnce();
      expect(receiver.state.requests).toHaveLength(1);
      expect(receiverB.state.requests).toHaveLength(1);
      expect(JSON.parse(receiver.state.requests[0].body).data.documentType).toBe('Transcript');
      expect(JSON.parse(receiverB.state.requests[0].body).data.documentType).toBe('Fee Receipt');
      expect(verifySignature(ha.secret, receiver.state.requests[0])).toBe(true);
      expect(verifySignature(hb.secret, receiverB.state.requests[0])).toBe(true);
      expect(verifySignature(ha.secret, receiverB.state.requests[0])).toBe(false);
      expect(await runAsTenant(B._id, () => WebhookDelivery.countDocuments({}))).toBe(1);
      expect(await runUnscoped(() => WebhookDelivery.countDocuments({}))).toBe(2);
    } finally {
      await receiverB.close();
    }
  });
});
