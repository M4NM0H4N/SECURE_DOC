'use strict';

process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, request } = require('./helpers');
const auditService = require('../services/auditService');
const authorize = require('../middleware/authorize');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);
afterEach(() => jest.restoreAllMocks());

describe('authorize middleware (unit)', () => {
  const run = (user, ...roles) => {
    const next = jest.fn();
    authorize(...roles)({ user }, {}, next);
    return next.mock.calls[0][0];
  };

  test('allows listed roles', () => {
    expect(run({ role: 'HOD' }, 'HOD', 'CLERK')).toBeUndefined();
  });

  test('denies other roles and missing users with 403', () => {
    expect(run({ role: 'STUDENT' }, 'HOD').status).toBe(403);
    expect(run(undefined, 'HOD').status).toBe(403);
  });
});

describe('static files and path exposure', () => {
  test.each(['/.env', '/server/app.js', '/package.json', '/uploads/anything.pdf', '/docs/FINAL_IMPLEMENTATION_BLUEPRINT.md'])(
    'SECURITY: %s is not served',
    async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toMatch(/JWT_SECRET|MONGODB_URI|"dependencies"/);
    }
  );

  test('SECURITY: encoded traversal cannot escape the client folder', async () => {
    for (const url of ['/%2e%2e/.env', '/..%2f.env', '/%2e%2e%2f%2e%2e%2fpackage.json', '/css/..%2f..%2f.env']) {
      const res = await request(app).get(url);
      expect([400, 403, 404]).toContain(res.status);
      expect(res.text).not.toMatch(/JWT_SECRET|"dependencies"/);
    }
  });

  test('pages are served as HTML', async () => {
    for (const url of ['/login.html', '/register.html', '/student/', '/clerk/', '/hod/', '/admin/', '/admin/audit.html', '/request.html']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
  });

  test('unknown page -> friendly HTML 404; unknown API route and JSON clients -> JSON 404', async () => {
    const page = await request(app).get('/nope.html').set('Accept', 'text/html');
    expect(page.status).toBe(404);
    expect(page.text).toMatch(/Page not found/);
    const api = await request(app).get('/api/nope').set('Accept', 'text/html');
    expect(api.status).toBe(404);
    expect(api.body.success).toBe(false);
    const json = await request(app).get('/nope').set('Accept', 'application/json');
    expect(json.body.success).toBe(false);
  });
});

describe('security headers', () => {
  test('CSP, framing, sniffing and fingerprinting headers are set', async () => {
    const res = await request(app).get('/login.html');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  test('no permissive CORS headers are sent', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handling does not leak internals', () => {
  test('malformed JSON -> 400 JSON, no stack trace', async () => {
    const res = await request(app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.text).not.toMatch(/SyntaxError|at .*\.js|node_modules/);
  });

  test('oversized JSON body -> 413', async () => {
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'a@b.com', password: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
  });

  test('unexpected server error -> generic 500 without the internal message', async () => {
    const student = await createUser({ role: 'STUDENT', department: 'CSE' });
    const agent = await loginAgent(app, student);
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('secret internal detail /etc/db-password'));
    const res = await agent.post('/api/requests').set(CSRF).send({ documentType: 'Other', purpose: 'Testing error handling path' });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Internal server error');
    expect(res.text).not.toMatch(/secret internal detail|db-password|stack/i);
  });
});

describe('rate limiting behaviour', () => {
  test('successful logins do not count toward the login limit, failures do', async () => {
    const limited = makeApp({ authRateLimitMax: 3 });
    const user = await createUser({ role: 'STUDENT', email: 'limit@example.com' });
    for (let i = 0; i < 6; i += 1) {
      const ok = await request(limited).post('/api/auth/login').set(CSRF).send({ email: user.email, password: 'Passw0rdTest' });
      expect(ok.status).toBe(200);
    }
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await request(limited).post('/api/auth/login').set(CSRF).send({ email: user.email, password: 'WrongPass1' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  test('registration is rate limited', async () => {
    const limited = makeApp({ authRateLimitMax: 2 });
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push((await request(limited).post('/api/auth/register').set(CSRF).send({ name: 'Rate Test', email: `rate${i}@example.com`, password: 'Passw0rdOK', department: 'CSE' })).status);
    }
    expect(codes).toEqual([201, 201, 429, 429]);
  });

  test('uploads have their own limit', async () => {
    const limited = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 2 });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const agent = await loginAgent(limited, clerk);
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push((await agent.post('/api/requests/64b7f0f0f0f0f0f0f0f0f0f0/document').set(CSRF).attach('document', Buffer.from('%PDF-1.4\n'), { filename: 'a.pdf' })).status);
    }
    expect(codes.slice(2)).toEqual([429, 429]);
    expect(codes[0]).not.toBe(429);
  });
});

describe('frontend source rules (XSS / CSP regression guard)', () => {
  const clientDir = path.resolve(__dirname, '..', '..', 'client');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(clientDir);
  const js = files.filter((f) => f.endsWith('.js'));
  const html = files.filter((f) => f.endsWith('.html'));

  test('JavaScript never assigns innerHTML/outerHTML or uses eval/document.write', () => {
    for (const f of js) {
      const src = fs.readFileSync(f, 'utf8');
      expect({ file: path.basename(f), bad: /\.(inner|outer)HTML\s*=|\beval\(|new Function\(|document\.write\(/.test(src) }).toEqual({ file: path.basename(f), bad: false });
    }
  });

  test('insertAdjacentHTML is used only once, for the static logo constant in layout.js', () => {
    const users = js.filter((f) => /insertAdjacentHTML/.test(fs.readFileSync(f, 'utf8')));
    expect(users.map((f) => path.basename(f))).toEqual(['layout.js']);
    const src = fs.readFileSync(users[0], 'utf8');
    expect(src.match(/insertAdjacentHTML\(/g)).toHaveLength(1);
    expect(src).toMatch(/insertAdjacentHTML\('afterbegin', LOGO\)/);
  });

  test('HTML has no inline scripts, inline event handlers or style attributes (CSP-safe)', () => {
    for (const f of html) {
      const src = fs.readFileSync(f, 'utf8');
      const name = path.relative(clientDir, f);
      expect({ name, inlineScript: /<script(?![^>]*\ssrc=)[^>]*>/i.test(src) }).toEqual({ name, inlineScript: false });
      expect({ name, handler: /\son[a-z]+\s*=/i.test(src) }).toEqual({ name, handler: false });
      expect({ name, style: /\sstyle\s*=/i.test(src) }).toEqual({ name, style: false });
    }
  });

  test('every page has a title, viewport meta and a main landmark', () => {
    for (const f of html) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).toMatch(/<title>[^<]+<\/title>/);
      expect(src).toMatch(/name="viewport"/);
      expect(src).toMatch(/<main/);
    }
  });
});
