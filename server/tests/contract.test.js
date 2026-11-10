'use strict';

// S7 gate: the documented API is the real API. Real responses (and real webhook payloads) are
// validated against the OpenAPI description, and the committed docs/openapi.json cannot go stale.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, request,
} = require('./helpers');
const { startFakeReceiver } = require('./fakes');
const { validate, responseSchema } = require('./schemaValidator');
const { buildSpec } = require('../openapi');
const config = require('../config/env');
const worker = require('../services/notificationWorker');
const ApiKey = require('../models/ApiKey');
const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const Notification = require('../models/Notification');

const spec = JSON.parse(JSON.stringify(buildSpec()));
let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Promise.all([ApiKey, Webhook, WebhookDelivery, Notification].map((M) => M.collection.deleteMany({})));
  config.webhookAllowPrivate = false;
});

const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const get = (key, url, headers = {}) => require('supertest')(app).get(`/api/t/default/v1${url}`).set(key ? { Authorization: `Bearer ${key}`, ...headers } : headers);
const errors = (schema, value) => validate(schema, value, spec);

async function data() {
  const student = await createUser({ role: 'STUDENT', department: 'CSE' });
  const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
  const hod = await createUser({ role: 'HOD', department: 'CSE' });
  const admin = await createUser({ role: 'ADMIN' });
  const a = { student: await loginAgent(app, student), clerk: await loginAgent(app, clerk), hod: await loginAgent(app, hod), admin: await loginAgent(app, admin) };
  const key = (await post(a.admin, '/api/admin/api-keys', { name: 'Contract', scopes: ['requests:read', 'analytics:read'] })).body.data.secret;
  const onlyAnalytics = (await post(a.admin, '/api/admin/api-keys', { name: 'Analytics only', scopes: ['analytics:read'] })).body.data.secret;
  const id = (await post(a.student, '/api/requests', { documentType: 'Transcript', purpose: 'A purpose that is long enough' })).body.data.request._id;
  await post(a.student, '/api/requests', { documentType: 'Fee Receipt', purpose: 'Another long enough purpose' });
  await a.clerk.patch(`/api/requests/${id}/advance`).set(CSRF).send({});
  await createRequest(student, { status: 'REJECTED' });
  await createRequest(student, { status: 'APPROVED' });
  return { a, key, onlyAnalytics, id, student };
}

describe('the checker itself (unit)', () => {
  const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 }, b: { type: 'string', nullable: true, enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'string', format: 'date-time' } } } };
  const check = (v) => validate(s, v, { components: {} });

  test('(unit) accepts what the schema allows', () => {
    expect(check({ a: 1 })).toEqual([]);
    expect(check({ a: 5, b: null, c: ['2026-01-02T03:04:05.000Z'] })).toEqual([]);
    expect(check({ a: 5, b: 'x' })).toEqual([]);
  });

  test('(unit) rejects every kind of mismatch, with the path', () => {
    expect(check({})[0]).toMatch(/missing required "a"/);
    expect(check({ a: '1' })[0]).toMatch(/\$\.a: expected integer/);
    expect(check({ a: 1.5 })[0]).toMatch(/not an integer/);
    expect(check({ a: 0 })[0]).toMatch(/below 1/);
    expect(check({ a: 1, extra: true })[0]).toMatch(/unexpected field "extra"/);
    expect(check({ a: 1, b: 'z' })[0]).toMatch(/not one of/);
    expect(check({ a: 1, c: ['yesterday'] })[0]).toMatch(/\$\.c\[0\].*not a date-time/);
    expect(check({ a: null })[0]).toMatch(/null is not allowed/);
    expect(check([])[0]).toMatch(/expected object/);
    expect(validate({ $ref: '#/components/schemas/Nope' }, {}, { components: { schemas: {} } })[0]).toMatch(/unresolved/);
    expect(validate({ allOf: [{ type: 'object', required: ['q'] }] }, {}, {})[0]).toMatch(/missing required "q"/);
  });
});

describe('the description', () => {
  test('every reference resolves, operation ids are unique, and every path is documented with error responses', () => {
    const refs = [];
    JSON.stringify(spec, (k, v) => {
      if (k === '$ref') refs.push(v);
      return v;
    });
    expect(refs.length).toBeGreaterThan(5);
    for (const r of refs) expect([r, require('./schemaValidator').resolve(r, spec) !== undefined]).toEqual([r, true]);
    const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
    expect(new Set(ops).size).toBe(ops.length);
    expect(Object.keys(spec.paths).sort()).toEqual(['/v1/analytics/summary', '/v1/openapi.json', '/v1/requests', '/v1/requests/{id}']);
    for (const p of ['/v1/requests', '/v1/requests/{id}', '/v1/analytics/summary']) expect(Object.keys(spec.paths[p].get.responses)).toEqual(expect.arrayContaining(['200', '401', '403']));
  });

  test('the committed docs/openapi.json is exactly what the code describes (run "npm run openapi" after changing it)', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8'));
    expect(committed).toEqual(spec);
  });
});

describe('real responses match the description', () => {
  test('list, detail and analytics (200) validate, and mutated responses do not', async () => {
    const { key, id } = await data();

    const list = await get(key, '/requests?limit=10');
    expect(list.status).toBe(200);
    const listSchema = responseSchema(spec, '/v1/requests', 200);
    expect(errors(listSchema, list.body)).toEqual([]);
    expect(list.body.data.items.length).toBe(4);
    expect(new Set(list.body.data.items.map((r) => r.status))).toEqual(new Set(['PENDING', 'UNDER_REVIEW', 'REJECTED', 'APPROVED']));

    const one = await get(key, `/requests/${id}`);
    expect(errors(responseSchema(spec, '/v1/requests/{id}', 200), one.body)).toEqual([]);
    expect(one.body.data.request.history.length).toBeGreaterThanOrEqual(2);

    const sum = await get(key, '/analytics/summary');
    expect(errors(responseSchema(spec, '/v1/analytics/summary', 200), sum.body)).toEqual([]);

    // The check can fail: each of these must be caught.
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const extra = clone(list.body);
    extra.data.items[0].studentName = 'Leak';
    expect(errors(listSchema, extra)[0]).toMatch(/unexpected field "studentName"/);
    const wrong = clone(list.body);
    wrong.data.items[0].status = 'DONE';
    expect(errors(listSchema, wrong)[0]).toMatch(/not one of/);
    const missing = clone(list.body);
    delete missing.data.items[0].createdAt;
    expect(errors(listSchema, missing)[0]).toMatch(/missing required "createdAt"/);
    const badDate = clone(list.body);
    badDate.data.items[0].updatedAt = 'tomorrow';
    expect(errors(listSchema, badDate)[0]).toMatch(/not a date-time/);
    const typo = clone(sum.body);
    typo.data.total = '8';
    expect(errors(responseSchema(spec, '/v1/analytics/summary', 200), typo)[0]).toMatch(/expected integer/);
  });

  test('a fulfilled request has a fulfilment time that validates', async () => {
    const { key, a, student } = await data();
    const r = (await post(a.student, '/api/requests', { documentType: 'Transcript', purpose: 'A purpose that is long enough' })).body.data.request._id;
    await a.clerk.patch(`/api/requests/${r}/advance`).set(CSRF).send({});
    await a.hod.patch(`/api/requests/${r}/advance`).set(CSRF).send({});
    await a.clerk.post(`/api/requests/${r}/document`).set(CSRF).attach('document', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf' });
    const res = await get(key, `/requests/${r}`);
    expect(res.body.data.request).toMatchObject({ status: 'FULFILLED', currentStep: null });
    expect(res.body.data.request.fulfilledAt).toMatch(/Z$/);
    expect(errors(responseSchema(spec, '/v1/requests/{id}', 200), res.body)).toEqual([]);
    void student;
  });

  test('error responses (400, 401, 403, 404, 429) all follow the documented envelope', async () => {
    const { key, onlyAnalytics } = await data();
    const cases = [
      [await get(key, '/requests?limit=101'), 400], [await get(key, '/requests/nope'), 400], [await get(null, '/requests'), 401],
      [await get(onlyAnalytics, '/requests'), 403], [await get(key, '/requests/64b64b64b64b64b64b64b640'), 404],
    ];
    for (const [res, status] of cases) {
      expect(res.status).toBe(status);
      expect(errors({ $ref: '#/components/schemas/Error' }, res.body)).toEqual([]);
    }
    expect(cases[0][0].body.errors[0]).toMatchObject({ field: 'limit' });

    const small = makeApp({ authRateLimitMax: 1000, apiKeyRateLimitMax: 1 });
    const call = () => require('supertest')(small).get('/api/t/default/v1/requests').set({ Authorization: `Bearer ${key}` });
    await call();
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(errors({ $ref: '#/components/schemas/Error' }, limited.body)).toEqual([]);
  });

  test('the public description endpoint serves the same document', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(spec);
    expect(res.body.openapi).toBe('3.0.3');
  });
});

describe('webhook payloads match the description', () => {
  test('every event type delivered validates as a WebhookEvent, and the data keys are only the documented ones', async () => {
    const receiver = await startFakeReceiver();
    config.webhookAllowPrivate = true;
    try {
      const { a } = await data();
      await post(a.admin, '/api/admin/webhooks', { name: 'Contract', url: receiver.url, events: ['request.submitted', 'request.status_changed', 'document.issued'] });
      const id = (await post(a.student, '/api/requests', { documentType: 'Transcript', purpose: 'A purpose that is long enough' })).body.data.request._id;
      await a.clerk.patch(`/api/requests/${id}/advance`).set(CSRF).send({});
      await a.hod.patch(`/api/requests/${id}/advance`).set(CSRF).send({});
      await a.clerk.post(`/api/requests/${id}/document`).set(CSRF).attach('document', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf' });
      await post(a.admin, `/api/admin/webhooks/${(await Webhook.findOne({}))._id}/ping`);
      await worker.runOnce();

      const events = receiver.state.requests.map((r) => JSON.parse(r.body));
      expect(new Set(events.map((e) => e.event))).toEqual(new Set(['request.submitted', 'request.status_changed', 'document.issued', 'ping']));
      const allowed = new Set(['requestId', 'documentType', 'department', 'status', 'previousStatus', 'step', 'documentId', 'version', 'fileType', 'message']);
      for (const e of events) {
        expect(errors({ $ref: '#/components/schemas/WebhookEvent' }, e)).toEqual([]);
        for (const k of Object.keys(e.data)) expect([e.event, k, allowed.has(k)]).toEqual([e.event, k, true]);
      }
      const bad = { ...events[0], event: 'request.deleted' };
      expect(errors({ $ref: '#/components/schemas/WebhookEvent' }, bad)[0]).toMatch(/not one of/);
    } finally {
      config.webhookAllowPrivate = false;
      await receiver.close();
    }
  });
});
