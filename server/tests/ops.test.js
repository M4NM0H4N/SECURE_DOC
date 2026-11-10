'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, createUser, loginAgent, request, CSRF } = require('./helpers');
const { createLogger, logger, redactString, clean } = require('../utils/logger');
const Heartbeat = require('../models/Heartbeat');
const worker = require('../services/notificationWorker');
const config = require('../config/env');

let app;
const lines = [];
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Heartbeat.deleteMany({});
  lines.length = 0;
  logger.setSink((l) => lines.push(JSON.parse(l)));
});
afterEach(() => {
  logger.setSink(null);
  config.workerMaxAgeSeconds = 0;
});

describe('logger (unit)', () => {
  test('writes one JSON object per line with level and time', () => {
    const out = [];
    createLogger({ level: 'info', write: (l) => out.push(l) }).info('hello', { a: 1 });
    const e = JSON.parse(out[0]);
    expect(e).toMatchObject({ level: 'info', msg: 'hello', a: 1 });
    expect(new Date(e.time).getTime()).not.toBeNaN();
  });

  test('respects the level threshold', () => {
    const out = [];
    const l = createLogger({ level: 'warn', write: (x) => out.push(x) });
    l.debug('d');
    l.info('i');
    l.warn('w');
    l.error('e');
    expect(out).toHaveLength(2);
  });

  test('masks sensitive keys and redacts credential-looking values', () => {
    const c = clean({ password: 'hunter2', token: 'abc', note: 'mail me at a.b@example.com', uri: 'x', nested: { authorization: 'Bearer zzz', ok: 'fine' } });
    expect(JSON.stringify(c)).not.toMatch(/hunter2|abc|example\.com|zzz/);
    expect(c.nested.ok).toBe('fine');
    expect(redactString('connect ' + 'mongodb+srv' + '://user:pw@cluster.example.net/db now')).not.toMatch(/user:pw|cluster/);
    expect(redactString('key dfk_abcd1234_SECRETSECRET')).not.toMatch(/SECRETSECRET/);
    expect(redactString('jwt ' + 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk')).toContain('[redacted]');
  });

  test('truncates long strings and deep objects', () => {
    expect(redactString('x'.repeat(2000)).length).toBeLessThan(600);
    expect(JSON.stringify(clean({ a: { b: { c: { d: 1 } } } }))).toContain('[truncated]');
  });
});

describe('access log', () => {
  test('logs the route pattern, status and a request id, not the URL, query or body', async () => {
    await request(app).get('/api/t/default/meta/departments?secretquery=hunter2').expect(200);
    const line = lines.find((l) => l.msg === 'request' && l.route.includes('departments'));
    expect(line).toBeDefined();
    expect(line).toMatchObject({ method: 'GET', status: 200, tenant: 'default' });
    expect(typeof line.requestId).toBe('string');
    expect(JSON.stringify(lines)).not.toMatch(/hunter2|secretquery/);
  });

  test('never logs credentials posted to login, nor the e-mail', async () => {
    await createUser({ email: 'victim@example.com', password: 'CorrectHorse9' });
    await request(app).post('/api/t/default/auth/login').set(CSRF).send({ email: 'victim@example.com', password: 'WrongPassword9' }).expect(401);
    const all = JSON.stringify(lines);
    expect(all).not.toMatch(/WrongPassword9|CorrectHorse9|victim@example\.com/);
    expect(lines.find((l) => l.status === 401)).toBeDefined();
  });

  test('echoes a sane X-Request-Id and replaces a hostile one', async () => {
    const good = await request(app).get('/healthz').set('X-Request-Id', 'abc12345-trace');
    expect(good.headers['x-request-id']).toBe('abc12345-trace');
    const bad = await request(app).get('/healthz').set('X-Request-Id', 'x\\ninjected "line"');
    expect(bad.headers['x-request-id']).not.toContain('injected');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a signed-in request logs an id but never the user name or e-mail', async () => {
    const jane = await createUser({ email: 'jane.private@example.com' });
    const agent = await loginAgent(app, jane);
    await agent.get('/api/t/default/requests').expect(200);
    const all = JSON.stringify(lines);
    expect(all).not.toMatch(/Jane Private|jane\.private/);
  });

  test('a server error is logged with the request id, and the client gets no internals', async () => {
    const User = require('../models/User');
    jest.spyOn(User, 'findOne').mockImplementation(() => { throw new Error('boom mongodb' + '://u:p@h/db'); });
    const res = await request(app).post('/api/t/default/auth/login').set(CSRF).send({ email: 'a@b.co', password: 'Whatever123' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|mongodb/);
    const err = lines.find((l) => l.msg === 'unhandled error');
    expect(err.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(err)).not.toMatch(/u:p@h/);
  });
});

describe('readiness', () => {
  test('/healthz and /readyz are ok with the database up', async () => {
    await request(app).get('/healthz').expect(200);
    const r = await request(app).get('/readyz').expect(200);
    expect(r.body).toEqual({ status: 'ok', checks: { database: true } });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('with the worker check on, no heartbeat means not ready', async () => {
    config.workerMaxAgeSeconds = 60;
    const r = await request(app).get('/readyz').expect(503);
    expect(r.body.checks.worker).toBe(false);
  });

  test('a worker pass writes a heartbeat that makes it ready, and a stale one does not', async () => {
    config.workerMaxAgeSeconds = 60;
    await worker.runOnce();
    await request(app).get('/readyz').expect(200);
    await Heartbeat.updateOne({ name: 'worker' }, { $set: { at: new Date(Date.now() - 120000) } });
    await request(app).get('/readyz').expect(503);
  });

  test('readiness exposes only booleans, no counts, names or versions', async () => {
    config.workerMaxAgeSeconds = 60;
    await worker.runOnce();
    const r = await request(app).get('/readyz');
    expect(Object.keys(r.body).sort()).toEqual(['checks', 'status']);
    expect(Object.values(r.body.checks).every((v) => typeof v === 'boolean')).toBe(true);
  });

  test('the probes are not rate limited', async () => {
    const tight = makeApp({ apiRateLimitMax: 1 });
    for (let i = 0; i < 5; i += 1) await request(tight).get('/readyz').expect(200);
  });
});
