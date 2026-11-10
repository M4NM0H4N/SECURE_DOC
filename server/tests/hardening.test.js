'use strict';

process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const supertest = require('supertest');
const { startDb, stopDb, clearDb, makeApp, createUser, loginAgent, makeTenant, request, CSRF } = require('./helpers');
const { redactString } = require('../utils/logger');

// Security review as executable checks. The sweeps enumerate the app's REAL routes, so a route added
// later is checked automatically; a new public route must be added to PUBLIC below on purpose.
let app;
let routes;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 100000, apiRateLimitMax: 100000, uploadRateLimitMax: 100000 });
  routes = collectTenantRoutes(app);
});
afterAll(stopDb);
beforeEach(clearDb);

// ---- route discovery (Express 4 internals, test-only) ----------------------------------------
function mountPath(layer) {
  const src = layer.regexp.source;
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = /^\^(.+?)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
  if (!m) return null; // parameterised or unusual mount
  return m[1].replace(/\\\//g, '/');
}
function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) for (const method of Object.keys(layer.route.methods)) out.push({ method, path: prefix + p });
    } else if (layer.handle && layer.handle.stack) {
      const mp = mountPath(layer);
      if (mp !== null) walk(layer.handle.stack, prefix + mp, out);
    }
  }
}
function collectTenantRoutes(a) {
  const tenantLayer = a._router.stack.find((l) => l.handle && l.handle.stack && l.keys && l.keys.some((k) => k.name === 'slug'));
  const out = [];
  walk(tenantLayer.handle.stack, '', out);
  return out;
}
const SAMPLE_ID = '64b64b64b64b64b64b64b64b';
const concrete = (p) => p.replace(/:docId/g, SAMPLE_ID).replace(/:id/g, SAMPLE_ID).replace(/:[A-Za-z]+/g, 'x');
const key = (r) => `${r.method.toUpperCase()} ${r.path}`;

// Routes that answer without a session on purpose. Anything else must refuse anonymous callers.
const PUBLIC = new Set([
  'POST /auth/register', 'POST /auth/login', 'POST /auth/logout', 'POST /auth/forgot-password', 'POST /auth/reset-password',
  'POST /auth/verify-email', 'GET /auth/invite', 'POST /auth/accept-invite', 'POST /auth/login/mfa', 'POST /auth/resend-verification',
  'GET /meta/departments', 'GET /branding/', 'GET /branding/logo', 'GET /v1/openapi.json',
]);
const isPublic = (r) => PUBLIC.has(key(r)) || r.path.startsWith('/verify');

describe('route inventory', () => {
  test('the sweep found the application\'s routes', () => {
    expect(routes.length).toBeGreaterThan(80);
    for (const must of ['/auth/login', '/requests', '/admin/users', '/analytics/summary', '/v1/requests', '/admin/data-export', '/admin/webhooks']) {
      expect(routes.some((r) => r.path === must || r.path.startsWith(must))).toBe(true);
    }
  });
});

describe('every route refuses anonymous callers unless it is deliberately public', () => {
  test('no unlisted route answers without a session', async () => {
    const open = [];
    const crashed = [];
    for (const r of routes.filter((x) => !isPublic(x))) {
      const res = await supertest(app)[r.method](`/api/t/default${concrete(r.path)}`).set(CSRF).send({});
      if (res.status >= 500) crashed.push(`${key(r)} -> ${res.status}`);
      if (![401, 403].includes(res.status)) open.push(`${key(r)} -> ${res.status}`);
    }
    expect({ open, crashed }).toEqual({ open: [], crashed: [] });
  });

  test('the public list contains only routes that really exist (no stale entries)', () => {
    const have = new Set(routes.map(key));
    expect([...PUBLIC].filter((p) => !have.has(p))).toEqual([]);
  });
});

describe('role walls', () => {
  test('a Student gets 403 on every Admin, analytics and staff-only route', async () => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    const wrong = [];
    for (const r of routes.filter((x) => x.path.startsWith('/admin') || x.path.startsWith('/analytics'))) {
      const res = await agent[r.method](concrete(`/api${r.path}`)).set(CSRF).send({});
      if (res.status !== 403) wrong.push(`${key(r)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  test('a Clerk gets 403 on every Admin route', async () => {
    const clerk = await createUser({ role: 'CLERK' });
    const agent = await loginAgent(app, clerk);
    const wrong = [];
    for (const r of routes.filter((x) => x.path.startsWith('/admin'))) {
      const res = await agent[r.method](concrete(`/api${r.path}`)).set(CSRF).send({});
      if (res.status !== 403) wrong.push(`${key(r)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('institution isolation on every route', () => {
  test('an Admin session of one institution is useless on every route of another', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    await makeTenant('rival-college');
    const leaked = [];
    for (const r of routes.filter((x) => !isPublic(x))) {
      const res = await supertest.agent(app)[r.method](`/api/t/rival-college${concrete(r.path)}`)
        .set('Cookie', agent.jar ? agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }).map((c) => c.toValueString()).join('; ') : '')
        .set(CSRF).send({});
      if (![401, 403, 404].includes(res.status)) leaked.push(`${key(r)} -> ${res.status}`);
    }
    expect(leaked).toEqual([]);
  });

  test('the same cookie, sent by hand to another institution, is refused on a data route', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const login = await request(app).post('/api/auth/login').set(CSRF).send({ email: admin.email, password: 'Passw0rdTest' });
    const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    await makeTenant('rival-college');
    expect((await supertest(app).get('/api/t/default/admin/users').set('Cookie', cookie)).status).toBe(200);
    expect((await supertest(app).get('/api/t/rival-college/admin/users').set('Cookie', cookie)).status).toBe(401);
    expect((await supertest(app).get('/api/t/rival-college/admin/data-export').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('input hardening', () => {
  test('MongoDB operator objects in credentials are rejected, never evaluated', async () => {
    await createUser({ role: 'STUDENT', email: 'target@example.com' });
    for (const body of [{ email: { $gt: '' }, password: { $gt: '' } }, { email: 'target@example.com', password: { $ne: null } }, { email: { $regex: '.*' }, password: 'x' }]) {
      const res = await request(app).post('/api/auth/login').set(CSRF).send(body);
      expect([400, 401]).toContain(res.status);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  test('prototype-pollution keys in a body do not change behaviour or crash', async () => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    const res = await agent.post('/api/requests').set(CSRF).send(JSON.parse('{"documentType":"Transcript","purpose":"Needed for a visa application","__proto__":{"isAdmin":true},"constructor":{"prototype":{"role":"ADMIN"}}}'));
    expect(res.status).toBeLessThan(500);
    expect({}.isAdmin).toBeUndefined();
    expect((await agent.get('/api/admin/users')).status).toBe(403);
  });

  test('a student cannot choose their own role or institution at registration', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).send({ name: 'Mallory Test', email: 'mallory@example.com', password: 'Passw0rdTest', department: 'CSE', role: 'ADMIN', tenantId: SAMPLE_ID });
    if (res.status === 201) expect(res.body.data.user.role).toBe('STUDENT');
    const User = require('../models/User');
    const u = await User.findOne({ email: 'mallory@example.com' });
    if (u) {
      expect(u.role).toBe('STUDENT');
      expect(String(u.tenantId)).not.toBe(SAMPLE_ID);
    }
  });

  test('login does not reveal whether an account exists', async () => {
    await createUser({ role: 'STUDENT', email: 'exists@example.com' });
    const a = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'exists@example.com', password: 'WrongPassw0rd' });
    const b = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'ghost@example.com', password: 'WrongPassw0rd' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  test('forgot-password answers the same for a known and an unknown address', async () => {
    await createUser({ role: 'STUDENT', email: 'known@example.com' });
    const a = await request(app).post('/api/auth/forgot-password').set(CSRF).send({ email: 'known@example.com' });
    const b = await request(app).post('/api/auth/forgot-password').set(CSRF).send({ email: 'nobody@example.com' });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  test('mutating requests without the CSRF header are refused on every non-public route', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    const wrong = [];
    for (const r of routes.filter((x) => ['post', 'put', 'patch', 'delete'].includes(x.method) && !isPublic(x))) {
      const res = await agent[r.method](concrete(`/api${r.path}`)).send({});
      if (res.status !== 403) wrong.push(`${key(r)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('what the web server exposes', () => {
  test.each(['/.env', '/package.json', '/server/app.js', '/server/config/env.js', '/scripts/backup.js', '/docs/openapi.json', '/mongo-data/', '/render.yaml', '/.git/config', '/node_modules/express/package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/js/../../package.json'])(
    '%s is not served', async (p) => {
      const res = await supertest(app).get(p).set('Accept', 'text/html');
      expect(res.status).toBe(404);
      expect(res.text).not.toMatch(/"dependencies"|JWT_SECRET|require\('/);
    }
  );

  test('API responses are not cacheable by default; only public branding is', async () => {
    const student = await createUser({ role: 'STUDENT' });
    const agent = await loginAgent(app, student);
    expect((await agent.get('/api/auth/me')).headers['cache-control']).toMatch(/no-store/);
    expect((await agent.get('/api/requests')).headers['cache-control']).toMatch(/no-store/);
    expect((await request(app).get('/api/branding')).headers['cache-control']).toMatch(/public/);
  });

  test('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const u = await createUser({ role: 'STUDENT' });
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: 'Passw0rdTest' });
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  test('error responses carry a request id for support, and never a stack trace', async () => {
    const res = await supertest(app).get('/api/t/default/requests/not-an-id').set(CSRF);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(.*:\d+:\d+\)|node_modules/);
  });
});

describe('secrets never reach logs or source control', () => {
  test('the log redactor removes connection strings, bearer tokens, API keys and e-mail addresses', () => {
    const dirty = 'u=a.b@c.org ' + 'mongodb' + '+srv://x:y@z.mongodb.net/db Bearer abc.def.ghi dfk_abcd1234_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    expect(redactString(dirty)).not.toMatch(/a\.b@c\.org|x:y@z|abc\.def\.ghi|zzzzzz/);
  });

  test('no committed file contains a credential-shaped value', () => {
    const root = path.resolve(__dirname, '..', '..');
    const skip = new Set(['node_modules', '.git', 'mongo-data', 'reports', 'vendor', 'test-results', 'playwright-report']);
    const hits = [];
    const walkDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(full);
        else if (/\.(js|json|html|md|yml|yaml|example)$/.test(e.name) && e.name !== 'package-lock.json' && !full.includes(`${path.sep}tests${path.sep}`)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/mongodb(\+srv)?:\/\/[^\s'"<>]*:[^\s'"<>@]+@/.test(text)) hits.push(`${path.relative(root, full)}: connection string with password`);
          if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(text)) hits.push(`${path.relative(root, full)}: private key`);
          if (/\bre_[A-Za-z0-9]{20,}\b|\bsk_live_[A-Za-z0-9]+|\bAKIA[0-9A-Z]{16}\b/.test(text)) hits.push(`${path.relative(root, full)}: provider key`);
        }
      }
    };
    walkDir(root);
    expect(hits).toEqual([]);
  });

  test('.env is ignored by git', () => {
    expect(fs.readFileSync(path.resolve(__dirname, '..', '..', '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
  });
});
