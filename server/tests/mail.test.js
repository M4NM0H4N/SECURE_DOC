'use strict';

// S5: templates, the Resend provider (against a fake HTTPS API) and the configuration guards.
process.env.NODE_ENV = 'test';
const http = require('http');
const config = require('../config/env');
const mailer = require('../services/mailer');
const { render, esc, TEMPLATE_NAMES } = require('../services/mailTemplates');

describe('mail templates (unit)', () => {
  const sample = {
    name: 'Asha Rao', institution: 'KLE Tech', link: 'https://docflow.example.com/t/kle/request.html?id=abc', role: 'CLERK',
    documentType: 'Transcript', studentName: 'Ravi Kumar', stepLabel: 'Clerk review', reason: 'Fees pending', note: 'Add your roll number',
  };

  test.each(TEMPLATE_NAMES)('(unit) %s renders a subject, text and HTML with its link and no "undefined"', (name) => {
    const m = render(name, sample);
    expect(m.subject.length).toBeGreaterThan(5);
    expect(m.text).toContain('KLE Tech');
    expect(m.text).toContain(sample.link);
    expect(m.html).toContain(`href="${sample.link}"`);
    for (const part of [m.subject, m.text, m.html]) expect(part).not.toMatch(/undefined|\[object/);
  });

  test('(unit) every value is escaped for HTML, in the body and in the link', () => {
    const evil = { ...sample, studentName: '<script>alert(1)</script>', documentType: '"><img src=x onerror=alert(1)>', stepLabel: "O'Neil & Sons", link: 'https://x.example.com/?a=1&b="2"' };
    const m = render('request-submitted', evil);
    expect(m.html).not.toMatch(/<script|<img /); // only escaped text remains, so no element can be injected
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('O&#39;Neil &amp; Sons');
    expect(m.html).toContain('href="https://x.example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('(unit) optional parts are left out cleanly and an unknown template is an error', () => {
    const m = render('request-rejected', { documentType: 'Transcript', institution: 'KLE Tech' });
    expect(m.text).not.toContain('Reason');
    expect(() => render('does-not-exist', {})).toThrow(/Unknown mail template/);
    expect(render('staff-invite', {}).text).toContain('your institution');
  });
});

describe('Resend provider', () => {
  let server;
  let received;
  let behaviour;
  const saved = { provider: config.mailProvider, from: config.mailFrom, resend: { ...config.resend } };

  beforeEach(async () => {
    received = [];
    behaviour = { status: 200, body: '{"id":"abc"}' };
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(behaviour.status, { 'content-type': 'application/json' });
        res.end(behaviour.body);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    config.mailProvider = 'resend';
    config.mailFrom = 'DocFlow <no-reply@example.com>';
    config.resend.apiKey = 'test-key-not-real';
    config.resend.apiUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    config.mailProvider = saved.provider;
    config.mailFrom = saved.from;
    Object.assign(config.resend, saved.resend);
    await new Promise((r) => server.close(r));
  });

  test('sends one authenticated JSON request with the rendered message and an idempotency key', async () => {
    const out = await mailer.send({ to: 'asha@example.com', template: 'request-fulfilled', data: { documentType: 'Transcript', institution: 'KLE Tech', link: 'https://x.example.com/r' }, idempotencyKey: 'notif-123' });
    expect(out).toEqual({ delivered: true });
    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/emails');
    expect(r.headers.authorization).toBe('Bearer test-key-not-real');
    expect(r.headers['idempotency-key']).toBe('notif-123');
    expect(r.headers['content-type']).toBe('application/json');
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ from: 'DocFlow <no-reply@example.com>', to: ['asha@example.com'], subject: 'Your document is ready: Transcript' });
    expect(body.text).toContain('https://x.example.com/r');
    expect(body.html).toContain('<a href="https://x.example.com/r">');
  });

  test.each([[400], [401], [422], [429], [500], [503]])('a %i answer is an error carrying only the status, never the provider text', async (status) => {
    behaviour = { status, body: '{"message":"leaked-detail https://x.example.com/secret-link api-key"}' };
    const err = await mailer.send({ to: 'a@example.com', template: 'request-fulfilled', data: { documentType: 'Transcript' } }).catch((e) => e);
    expect(err.message).toBe(`Mail provider returned ${status}`);
    expect(err.message).not.toMatch(/leaked|secret-link|api-key/);
  });

  test('an unreachable provider is an error without addresses or keys', async () => {
    await new Promise((r) => server.close(r));
    const err = await mailer.send({ to: 'a@example.com', template: 'request-fulfilled', data: { documentType: 'Transcript' } }).catch((e) => e);
    expect(err.message).toBe('Mail provider unreachable');
    server = http.createServer(); // so afterEach can close something
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });
});

describe('mail provider "none" and the outbox', () => {
  const saved = config.mailProvider;
  afterEach(() => {
    config.mailProvider = saved;
    mailer.clearOutbox();
  });

  test('none refuses to send and reports itself disabled', async () => {
    config.mailProvider = 'none';
    expect(mailer.enabled()).toBe(false);
    await expect(mailer.send({ to: 'a@example.com', template: 'request-fulfilled', data: {} })).rejects.toThrow(/No mail provider/);
  });

  test('the outbox keeps rendered messages for tests, bounded in size', async () => {
    config.mailProvider = 'outbox';
    mailer.clearOutbox();
    for (let i = 0; i < 210; i += 1) await mailer.send({ to: `u${i}@example.com`, template: 'request-fulfilled', data: { documentType: 'T' } });
    expect(mailer.sent()).toHaveLength(200);
    expect(mailer.lastTo('u209@example.com').message.subject).toMatch(/Your document is ready/);
    expect(mailer.lastTo('u0@example.com')).toBeNull();
  });
});

describe('mail and worker configuration guards (unit)', () => {
  function load(env) {
    const saved = { ...process.env };
    Object.assign(process.env, { PUBLIC_URL: 'https://docflow.example.com', MAIL_PROVIDER: '', MAIL_FROM: '', RESEND_API_KEY: '', RESEND_API_URL: '', WORKER_INLINE: '', HOST: '', TRUST_PROXY: '', UPLOAD_DIR: '', SCAN_MODE: 'off', CLAMD_HOST: '' }, env);
    try {
      let cfg;
      jest.isolateModules(() => {
        cfg = require('../config/env');
      });
      return cfg;
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }
  const resend = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'key', MAIL_FROM: 'no-reply@example.com' };
  const prod = { NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://example.invalid/db' };

  test('(unit) defaults: outbox in development, none in production; the worker is off unless asked', () => {
    expect(load({ NODE_ENV: 'development' })).toMatchObject({ mailProvider: 'outbox', workerInline: false });
    expect(load({ ...prod }).mailProvider).toBe('none');
    expect(load({ NODE_ENV: 'development', WORKER_INLINE: 'true' }).workerInline).toBe(true);
    expect(load({ NODE_ENV: 'development', WORKER_INLINE: 'yes' }).workerInline).toBe(false);
  });

  test('(unit) the provider is validated, and the in-memory outbox is refused in production', () => {
    expect(() => load({ MAIL_PROVIDER: 'smtp' })).toThrow(/MAIL_PROVIDER/);
    expect(() => load({ ...prod, MAIL_PROVIDER: 'outbox' })).toThrow(/not allowed in production/);
    expect(load({ ...prod, MAIL_PROVIDER: 'none' }).mailProvider).toBe('none');
  });

  test('(unit) resend needs a key, a sender and a sound API address', () => {
    expect(load({ ...resend }).mailProvider).toBe('resend');
    expect(() => load({ ...resend, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
    expect(() => load({ ...resend, MAIL_FROM: 'not an address' })).toThrow(/MAIL_FROM/);
    expect(load({ ...resend, MAIL_FROM: 'DocFlow <no-reply@example.com>' }).mailFrom).toBe('DocFlow <no-reply@example.com>');
    expect(() => load({ ...resend, RESEND_API_URL: 'https://api.example.com/v1' })).toThrow(/RESEND_API_URL/);
    expect(() => load({ ...resend, ...prod, RESEND_API_URL: 'http://api.example.com' })).toThrow(/https/);
    expect(load({ ...resend, ...prod }).resend.apiUrl).toBe('https://api.resend.com');
  });
});
