'use strict';

// S7: tenant branding (colour + logo) and the analytics / summary report.
process.env.NODE_ENV = 'test';
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, forgeToken, request, makeTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const config = require('../config/env');
const branding = require('../services/brandingService');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const Request = require('../models/Request');
const Tenant = require('../models/Tenant');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Notification.collection.deleteMany({});
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]);
const put = (agent, body) => agent.put('/api/admin/branding').set(CSRF).send(body);
const logo = (agent, buf, filename = 'logo.png', field = 'logo') => agent.post('/api/admin/branding/logo').set(CSRF).attach(field, buf, { filename });

async function admins() {
  const admin = await createUser({ role: 'ADMIN' });
  const clerk = await createUser({ role: 'CLERK' });
  return { a: await loginAgent(app, admin), clerk: await loginAgent(app, clerk), admin };
}

describe('branding colour and tagline', () => {
  test('(unit) the contrast rule: readable on white means at least 4.5:1', () => {
    expect(branding.contrastWithWhite('#000000')).toBeCloseTo(21, 0);
    expect(branding.contrastWithWhite('#FFFFFF')).toBeCloseTo(1, 1);
    expect(branding.contrastWithWhite('#767676')).toBeGreaterThanOrEqual(4.5);
    expect(branding.contrastWithWhite('#777777')).toBeLessThan(4.5);
    expect(branding.validateColor('#1a56db')).toBe('#1A56DB');
    for (const bad of ['red', '#12345', '#GGGGGG', '1A56DB', '#1A56DB00', '', '#FFFF00', '#AAAAAA']) expect(() => branding.validateColor(bad)).toThrow();
  });

  test('the public endpoint serves the name, colour, tagline and logo flag without signing in', async () => {
    const { a } = await admins();
    let res = await request(app).get('/api/branding');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'Default Institution', color: null, tagline: null, hasLogo: false, logoVersion: null });
    expect((await put(a, { color: '#1a56db', tagline: 'Certificates, simply' })).body.data).toMatchObject({ color: '#1A56DB', tagline: 'Certificates, simply' });
    res = await request(app).get('/api/branding');
    expect(res.body.data).toMatchObject({ color: '#1A56DB', tagline: 'Certificates, simply' });
    expect(res.headers['cache-control']).toMatch(/max-age/);
    expect(Object.keys(res.body.data).sort()).toEqual(['color', 'hasLogo', 'logoVersion', 'name', 'tagline']);
    expect((await request(app, 'no-such-college').get('/api/branding')).status).toBe(404);
  });

  test('colours that are not valid or not readable on white are refused with a clear message; null clears', async () => {
    const { a } = await admins();
    for (const color of ['red', '#12345', '#FFFF00', '#CCCCCC', 'javascript:alert(1)', '#1A56DBX']) {
      const res = await put(a, { color });
      expect([color, res.status]).toEqual([color, 400]);
    }
    expect((await put(a, { color: '#FFFF00' })).body.message).toMatch(/too light/);
    await put(a, { color: '#1A56DB' });
    expect((await put(a, { color: null })).body.data.color).toBeNull();
    expect((await put(a, { tagline: 'x'.repeat(121) })).status).toBe(400);
    expect((await put(a, { tagline: 42 })).status).toBe(400);
    expect((await put(a, { tagline: '' })).body.data.tagline).toBeNull();
  });

  test('only the Admin may change branding, changes are audited, and each institution has its own', async () => {
    const B = await makeTenant('beta-college', 'Beta College');
    const { a, clerk, admin } = await admins();
    expect((await put(clerk, { color: '#1A56DB' })).status).toBe(403);
    expect((await request(app).put('/api/admin/branding').set(CSRF).send({ color: '#1A56DB' })).status).toBe(401);
    await put(a, { color: '#1A56DB' });
    expect((await AuditLog.findOne({ action: 'BRANDING_UPDATED' })).details).toEqual({ what: 'colour and tagline' });
    expect((await request(app, 'beta-college').get('/api/branding')).body.data).toMatchObject({ name: 'Beta College', color: null });
    const token = forgeToken(admin._id);
    expect((await request(app, 'beta-college').put('/api/admin/branding').set(CSRF).set('Cookie', `${config.cookieName}=${token}`).send({ color: '#000000' })).status).toBe(401);
    expect((await Tenant.findById(B._id)).branding.color).toBeNull();
  });
});

describe('logo', () => {
  test('a PNG or JPEG is stored, served back unchanged with safe headers, and replaced or removed on request', async () => {
    const { a } = await admins();
    const res = await logo(a, PNG);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ hasLogo: true });
    const v1 = res.body.data.logoVersion;
    const img = await request(app).get('/api/branding/logo').buffer(true).parse((r, cb) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(img.status).toBe(200);
    expect(img.body.equals(PNG)).toBe(true);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toBe("default-src 'none'");

    await new Promise((r) => setTimeout(r, 5));
    const jpg = await logo(a, JPG, 'logo.jpg');
    expect(jpg.body.data.logoVersion).toBeGreaterThan(v1);
    expect((await request(app).get('/api/branding/logo')).headers['content-type']).toBe('image/jpeg');

    expect((await a.delete('/api/admin/branding/logo').set(CSRF)).body.data.hasLogo).toBe(false);
    expect((await request(app).get('/api/branding/logo')).status).toBe(404);
    expect((await AuditLog.find({ action: 'BRANDING_UPDATED' })).map((e) => e.details.what).sort()).toEqual(['logo added', 'logo added', 'logo removed']);
  });

  test('SECURITY: only real PNG/JPEG files are accepted (not SVG, HTML, PDF, GIF, text, empty or oversized)', async () => {
    const { a } = await admins();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const [name, buf, file] of [['svg', svg, 'x.svg'], ['html', Buffer.from('<html><script>1</script>'), 'x.html'], ['pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'x.pdf'], ['gif', Buffer.from('GIF89a......'), 'x.gif'], ['text', Buffer.from('plain text'), 'x.png'], ['png-named-svg', PNG.subarray(0, 4), 'x.svg']]) {
      const res = await logo(a, buf, file);
      expect([name, res.status]).toEqual([name, 400]);
    }
    expect((await logo(a, Buffer.concat([PNG, Buffer.alloc(101 * 1024)]))).status).toBe(413);
    expect((await logo(a, PNG, 'logo.png', 'image')).status).toBe(400); // wrong field name
    expect((await a.post('/api/admin/branding/logo').set(CSRF).send({})).status).toBe(400);
    expect((await request(app).get('/api/branding/logo')).status).toBe(404); // nothing was stored
    expect((await logo(a, Buffer.concat([PNG, Buffer.alloc(99 * 1024)]))).status).toBe(200); // just under the limit
  });

  test('admin-only, per institution, and the logo bytes never appear in any listing', async () => {
    const B = await makeTenant('beta-college');
    const { a, clerk } = await admins();
    expect((await logo(clerk, PNG)).status).toBe(403);
    expect((await a.delete('/api/admin/branding/logo').set(CSRF)).status).toBe(200); // removing nothing is harmless
    await logo(a, PNG);
    expect((await request(app, 'beta-college').get('/api/branding/logo')).status).toBe(404);
    expect((await request(app, 'beta-college').get('/api/branding')).body.data.hasLogo).toBe(false);
    expect((await Tenant.findById(B._id).select('+logo')).logo).toBeUndefined();

    // A platform operator listing institutions never receives the image.
    const su = await runUnscoped(async () => {
      const bcrypt = require('bcryptjs');
      return require('../models/User').create({ name: 'Owner', email: 'owner@platform.example.com', passwordHash: await bcrypt.hash('PlatformPass1', 4), role: 'SUPER_ADMIN' });
    });
    const platform = require('supertest').agent(app);
    await platform.post('/api/platform/auth/login').set(CSRF).send({ email: su.email, password: 'PlatformPass1' });
    const list = await platform.get('/api/platform/tenants');
    expect(JSON.stringify(list.body)).not.toMatch(/"logo"|PNG|iVBOR/);
  });
});

describe('analytics and the summary report', () => {
  const H = 3600 * 1000;
  async function seedNumbers() {
    const s = await createUser({ role: 'STUDENT', department: 'CSE', email: 'private.person@example.com' });
    const m = await createUser({ role: 'STUDENT', department: 'ME' });
    const day = (m0, d, h = 9) => new Date(Date.UTC(2026, m0, d, h));
    const fulfilled = async (student, created, hours, over = {}) => {
      const r = await createRequest(student, { status: 'FULFILLED', createdAt: created, purpose: 'Sensitive purpose text', ...over });
      await Request.collection.updateOne({ _id: r._id }, { $set: { createdAt: created, statusHistory: [{ from: null, to: 'PENDING', by: student._id, at: created }, { from: 'APPROVED', to: 'FULFILLED', by: student._id, at: new Date(created.getTime() + hours * H) }] } });
      return r;
    };
    await fulfilled(s, day(0, 5), 10);
    await fulfilled(s, day(0, 6), 20, { documentType: 'Bonafide Certificate' });
    await fulfilled(m, day(1, 2), 40, { department: 'ME', documentType: 'Fee Receipt' });
    const mk = async (student, status, created, over = {}) => {
      const r = await createRequest(student, { status, ...over });
      await Request.collection.updateOne({ _id: r._id }, { $set: { createdAt: created } });
      return r;
    };
    await mk(s, 'REJECTED', day(1, 10));
    await mk(s, 'APPROVED', day(1, 11));
    await mk(s, 'PENDING', day(1, 12));
    await mk(m, 'UNDER_REVIEW', day(1, 13), { department: 'ME' });
    await mk(s, 'NEEDS_INFO', day(1, 14));
    return { s, m };
  }
  const summary = (agent, qs = '') => agent.get(`/api/analytics/summary${qs}`);

  test('every figure is exact: counts, turnaround, rejection rate, backlog by step, months and escalations', async () => {
    const { s } = await seedNumbers();
    await Notification.create({ userId: s._id, channel: 'IN_APP', type: 'SLA_ESCALATION', dedupeKey: 'e1', status: 'SENT' });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const d = (await summary(admin)).body.data;
    expect(d.total).toBe(8);
    expect(d.byStatus).toEqual({ FULFILLED: 3, REJECTED: 1, APPROVED: 1, PENDING: 1, UNDER_REVIEW: 1, NEEDS_INFO: 1 });
    expect(d.byDepartment).toEqual({ CSE: 6, ME: 2 });
    expect(d.byDocumentType).toEqual({ 'Bonafide Certificate': 7, 'Fee Receipt': 1 });
    expect(d.byMonth).toEqual([{ month: '2026-01', count: 2 }, { month: '2026-02', count: 6 }]);
    expect(d.turnaround).toEqual({ fulfilled: 3, averageHours: 23.3, medianHours: 20, p90Hours: 40 });
    expect(d.rejection).toEqual({ rejected: 1, decided: 5, rate: 0.2 });
    expect(d.openRequests).toBe(4);
    expect(Object.fromEntries(d.backlog.map((b) => [b.step, b.count]))).toEqual({
      'Clerk review': 1, 'HOD decision': 1, 'Waiting for the student': 1, 'Awaiting document upload': 1,
    });
    expect(d.slaEscalations).toBe(1);
  });

  test('a period narrows the counts (the backlog is always "right now")', async () => {
    await seedNumbers();
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const jan = (await summary(admin, '?from=2026-01-01&to=2026-01-31')).body.data;
    expect(jan.total).toBe(2);
    expect(jan.byMonth).toEqual([{ month: '2026-01', count: 2 }]);
    expect(jan.turnaround).toMatchObject({ fulfilled: 2, averageHours: 15, medianHours: 10, p90Hours: 20 });
    expect(jan.rejection).toEqual({ rejected: 0, decided: 2, rate: 0 });
    expect(jan.openRequests).toBe(4);
    const feb = (await summary(admin, '?from=2026-02-01')).body.data;
    expect(feb.total).toBe(6);
    expect((await summary(admin, '?to=2025-12-31')).body.data.total).toBe(0);
    expect((await summary(admin, '?from=soon')).status).toBe(400);
  });

  test('an institution with no requests gets zeros and nulls, not errors', async () => {
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const d = (await summary(admin)).body.data;
    expect(d).toMatchObject({ total: 0, byStatus: {}, byMonth: [], openRequests: 0, backlog: [], slaEscalations: 0 });
    expect(d.turnaround).toEqual({ fulfilled: 0, averageHours: null, medianHours: null, p90Hours: null });
    expect(d.rejection).toEqual({ rejected: 0, decided: 0, rate: null });
  });

  test('only the Admin and the Principal can read it, and it holds no personal data', async () => {
    await seedNumbers();
    const principal = await loginAgent(app, await createUser({ role: 'PRINCIPAL', department: null }));
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    for (const who of [admin, principal]) {
      const res = await summary(who);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(JSON.stringify(res.body)).not.toMatch(/private\.person|Sensitive purpose|@example\.com|passwordHash|"name"/);
    }
    for (const role of ['STUDENT', 'CLERK', 'HOD']) {
      const agent = await loginAgent(app, await createUser({ role, department: 'CSE' }));
      expect([role, (await summary(agent)).status]).toEqual([role, 403]);
    }
    expect((await request(app).get('/api/analytics/summary')).status).toBe(401);
  });

  test('the spreadsheet summary lists the same numbers as metric/value rows', async () => {
    await seedNumbers();
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const res = await admin.get('/api/analytics/summary.csv?from=2026-01-01&to=2026-12-31');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/summary-\d{4}-\d{2}-\d{2}\.csv/);
    const rows = Object.fromEntries(res.text.trim().split('\r\n').slice(1).map((l) => l.slice(1, -1).split('","')));
    expect(rows['Requests submitted']).toBe('8');
    expect(rows['Average turnaround (hours)']).toBe('23.3');
    expect(rows['Rejection rate']).toBe('0.2');
    expect(rows['Department: CSE']).toBe('6');
    expect(rows['Month: 2026-02']).toBe('6');
    expect(rows['Waiting at: Clerk review']).toBe('1');
    expect((await request(app).get('/api/analytics/summary.csv')).status).toBe(401);
  });

  test('each institution sees only its own numbers', async () => {
    const B = await makeTenant('beta-college');
    await seedNumbers();
    const bStudent = await createUser({ role: 'STUDENT', department: 'CSE', tenant: B });
    await createRequest(bStudent, { status: 'PENDING' }, B);
    const a = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const b = await loginAgent(app, await createUser({ role: 'ADMIN', tenant: B }), 'Passw0rdTest', 'beta-college');
    expect((await summary(a)).body.data.total).toBe(8);
    expect((await summary(b)).body.data).toMatchObject({ total: 1, byStatus: { PENDING: 1 }, openRequests: 1 });
    expect(await runAsTenant(B._id, () => Request.countDocuments({}))).toBe(1);
    const token = forgeToken((await createUser({ role: 'ADMIN' }))._id);
    expect((await request(app, 'beta-college').get('/api/analytics/summary').set('Cookie', `${config.cookieName}=${token}`)).status).toBe(401);
  });
});
