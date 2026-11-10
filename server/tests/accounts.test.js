'use strict';

// S3 gate: invitations, password change/forgot/reset, e-mail verification, lockout,
// server-side session revocation and TOTP multi-factor authentication.
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, forgeToken, request, addStaff,
  makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const config = require('../config/env');
const mailer = require('../services/mailer');
const totp = require('../utils/totp');
const mfaService = require('../services/mfaService');
const User = require('../models/User');
const Invite = require('../models/Invite');
const AuthToken = require('../models/AuthToken');
const AuditLog = require('../models/AuditLog');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await Invite.collection.deleteMany({});
  await AuthToken.collection.deleteMany({});
  mailer.clearOutbox();
  config.requireEmailVerification = false;
  config.mfaKey = process.env.MFA_ENCRYPTION_KEY;
});

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tokenOf = (link) => new URL(link).searchParams.get('token');
const PASSWORD = 'Passw0rdTest';
const raw = (slug) => request(app, slug);
const login = (email, password = PASSWORD, slug) => raw(slug).post('/api/auth/login').set(CSRF).send({ email, password });
const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const invite = (agent, body) => post(agent, '/api/admin/invites', { name: 'Staff Person', email: 'staff@example.com', role: 'CLERK', department: 'CSE', ...body });

// Runs fn with the clock moved by offsetMs (TOTP steps and expiry are time based).
async function atOffset(offsetMs, fn) {
  const real = Date.now();
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => real + offsetMs);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe('TOTP (unit)', () => {
  const SECRET = totp.base32Encode(Buffer.from('12345678901234567890')); // RFC 6238 test key
  test('(unit) matches the RFC 6238 SHA-1 test vectors (last six digits)', () => {
    for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
      expect(totp.generate(SECRET, seconds * 1000)).toBe(expected);
    }
  });

  test('(unit) base32 round trips and rejects junk', () => {
    const bytes = crypto.randomBytes(20);
    expect(totp.base32Decode(totp.base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(totp.generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(() => totp.base32Decode('not base32!')).toThrow();
  });

  test('(unit) accepts one step either side, not two, and reports the matched step', () => {
    const now = 1111111109 * 1000;
    const code = totp.generate(SECRET, now);
    expect(totp.verify(SECRET, code, now)).toEqual({ valid: true, timeStep: totp.stepOf(now) });
    expect(totp.verify(SECRET, code, now + 30000).valid).toBe(true);
    expect(totp.verify(SECRET, code, now - 30000).valid).toBe(true);
    expect(totp.verify(SECRET, code, now + 60000).valid).toBe(false);
    expect(totp.verify(SECRET, '12345', now).valid).toBe(false);
    expect(totp.verify(SECRET, 'abcdef', now).valid).toBe(false);
    expect(totp.verify(SECRET, 123456, now).valid).toBe(false);
  });

  test('(unit) secrets are encrypted with a random IV and tampering is detected', () => {
    const secret = totp.generateSecret();
    const a = mfaService.encrypt(secret);
    const b = mfaService.encrypt(secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(mfaService.decrypt(a)).toBe(secret);
    const parts = a.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => mfaService.decrypt(parts.join('.'))).toThrow();
  });

  test('(unit) configuration guards: PUBLIC_URL and MFA key', () => {
    const load = (env) => {
      const saved = { ...process.env };
      Object.assign(process.env, { PUBLIC_URL: '', MFA_ENCRYPTION_KEY: '', MAIL_PROVIDER: '', HOST: '', TRUST_PROXY: '', UPLOAD_DIR: '', ...env });
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
    };
    const prod = { NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://example.invalid/db' };
    expect(() => load({ ...prod })).toThrow(/PUBLIC_URL/);
    expect(() => load({ ...prod, PUBLIC_URL: 'http://docflow.example.com' })).toThrow(/PUBLIC_URL/);
    expect(load({ ...prod, PUBLIC_URL: 'https://docflow.example.com/' }).publicUrl).toBe('https://docflow.example.com');
    expect(() => load({ PUBLIC_URL: 'https://x.example.com/path' })).toThrow(/origin/);
    expect(() => load({ PUBLIC_URL: 'not a url' })).toThrow(/origin/);
    expect(() => load({ MFA_ENCRYPTION_KEY: 'short' })).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(load({ NODE_ENV: 'test' }).publicUrl).toMatch(/^http:\/\/localhost:\d+$/); // sensible dev default
  });
});

describe('staff invitations', () => {
  test('an admin invites; the link is shown once, only a hash is stored, and nothing sensitive is listed', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const res = await invite(a);
    expect(res.status).toBe(201);
    const token = tokenOf(res.body.data.link);
    expect(res.body.data.link).toMatch(/^http:\/\/localhost:\d+\/t\/default\/accept-invite\.html\?token=[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash/);

    const stored = await Invite.findOne({}).select('+tokenHash');
    expect(stored.tokenHash).toBe(sha(token));
    expect(JSON.stringify(await Invite.collection.find({}).toArray())).not.toContain(token);
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

    const list = await a.get('/api/admin/invites');
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].status).toBe('PENDING');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(mailer.lastTo('staff@example.com', 'staff-invite').data.link).toBe(res.body.data.link);
    expect((await AuditLog.findOne({ action: 'INVITE_CREATED' })).details).toEqual({ inviteId: String(stored._id), role: 'CLERK', department: 'CSE' });
  });

  test('the invitee sets their own password; the account is verified and can sign in; the link works once', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const token = tokenOf((await invite(a)).body.data.link);

    const peek = await raw().get(`/api/auth/invite?token=${token}`);
    expect(peek.body.data.invite).toEqual({ email: 'staff@example.com', role: 'CLERK', department: 'CSE', name: 'Staff Person' });

    const accept = await post(raw(), '/api/auth/accept-invite', { token, name: 'Chosen Name', password: 'MyOwnPass123' });
    expect(accept.status).toBe(201);
    expect(accept.body.data.user).toMatchObject({ role: 'CLERK', department: 'CSE', name: 'Chosen Name' });
    expect(accept.body.data.user.emailVerifiedAt).toBeTruthy();
    expect((await login('staff@example.com', 'MyOwnPass123')).status).toBe(200);

    expect((await post(raw(), '/api/auth/accept-invite', { token, name: 'Again Person', password: 'MyOwnPass123' })).status).toBe(400);
    expect((await raw().get(`/api/auth/invite?token=${token}`)).status).toBe(400);
    expect(await User.countDocuments({ email: 'staff@example.com' })).toBe(1);
    expect((await AuditLog.findOne({ action: 'INVITE_ACCEPTED' })).details).toMatchObject({ role: 'CLERK' });
  });

  test('bad, unknown, used, revoked and expired links all answer the same 400', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const used = tokenOf((await invite(a, { email: 'used@example.com' })).body.data.link);
    await post(raw(), '/api/auth/accept-invite', { token: used, name: 'Used Person', password: 'MyOwnPass123' });
    const revoked = await invite(a, { email: 'revoked@example.com' });
    await a.delete(`/api/admin/invites/${revoked.body.data.invite._id}`).set(CSRF);
    const expiredRes = await invite(a, { email: 'expired@example.com' });
    await Invite.updateOne({ _id: expiredRes.body.data.invite._id }, { expiresAt: new Date(Date.now() - 1000) });

    const attempts = [
      'short', 'x'.repeat(43), crypto.randomBytes(32).toString('base64url'), used,
      tokenOf(revoked.body.data.link), tokenOf(expiredRes.body.data.link),
    ];
    const messages = new Set();
    for (const token of attempts) {
      const res = await post(raw(), '/api/auth/accept-invite', { token, name: 'Some Person', password: 'MyOwnPass123' });
      expect(res.status).toBe(400);
      messages.add(JSON.stringify(res.body.errors ? res.body.errors[0].message : res.body.message));
      const peek = await raw().get(`/api/auth/invite?token=${token}`);
      expect(peek.status).toBe(400);
    }
    expect(messages.size).toBe(1);
    expect((await a.get('/api/admin/invites')).body.data.items.map((i) => i.status).sort()).toEqual(['ACCEPTED', 'EXPIRED', 'REVOKED']);
  });

  test('resending replaces the link, and a new invitation replaces an earlier pending one', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const first = await invite(a);
    const oldToken = tokenOf(first.body.data.link);
    const resent = await post(a, `/api/admin/invites/${first.body.data.invite._id}/resend`);
    expect(resent.status).toBe(200);
    const newToken = tokenOf(resent.body.data.link);
    expect(newToken).not.toBe(oldToken);
    expect((await raw().get(`/api/auth/invite?token=${oldToken}`)).status).toBe(400);
    expect((await raw().get(`/api/auth/invite?token=${newToken}`)).status).toBe(200);

    const second = await invite(a, { role: 'HOD' });
    expect((await raw().get(`/api/auth/invite?token=${newToken}`)).status).toBe(400); // superseded
    expect((await raw().get(`/api/auth/invite?token=${tokenOf(second.body.data.link)}`)).body.data.invite.role).toBe('HOD');
    expect((await post(a, `/api/admin/invites/${first.body.data.invite._id}/resend`)).status).toBe(404); // revoked
  });

  test('rules: existing e-mail, role, department, Principal, weak password, admin only', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const clerk = await createUser({ role: 'CLERK' });
    await createUser({ role: 'STUDENT', email: 'taken@example.com' });
    const a = await loginAgent(app, admin);
    expect((await invite(a, { email: 'taken@example.com' })).status).toBe(409);
    expect((await invite(a, { role: 'ADMIN' })).status).toBe(400);
    expect((await invite(a, { role: 'STUDENT' })).status).toBe(400);
    expect((await invite(a, { department: 'NOPE' })).status).toBe(400);
    expect((await invite(a, { department: undefined })).status).toBe(400);
    expect((await invite(a, { email: 'not-an-email' })).status).toBe(400);
    const principal = await invite(a, { email: 'principal@example.com', role: 'PRINCIPAL', department: 'CSE' });
    expect(principal.status).toBe(201);
    expect(principal.body.data.invite.department).toBeNull();

    const token = tokenOf((await invite(a, { email: 'weak@example.com' })).body.data.link);
    expect((await post(raw(), '/api/auth/accept-invite', { token, name: 'Weak Person', password: 'short' })).status).toBe(400);
    expect((await raw().get(`/api/auth/invite?token=${token}`)).status).toBe(200); // a rejected form does not burn the link

    const c = await loginAgent(app, clerk);
    expect((await invite(c)).status).toBe(403);
    expect((await c.get('/api/admin/invites')).status).toBe(403);
    expect((await request(app).post('/api/admin/invites').set(CSRF).send({})).status).toBe(401);
  });

  test('if the department is deactivated before acceptance the link is refused and stays usable', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const a = await loginAgent(app, admin);
    const token = tokenOf((await invite(a, { department: 'ECE' })).body.data.link);
    const ece = await (require('../models/Department')).findOne({ code: 'ECE' });
    await a.patch(`/api/admin/departments/${ece._id}`).set(CSRF).send({ isActive: false });
    const res = await post(raw(), '/api/auth/accept-invite', { token, name: 'Late Person', password: 'MyOwnPass123' });
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ email: 'staff@example.com' })).toBe(0);
    expect((await Invite.findOne({})).usedAt).toBeNull(); // rolled back with the failed account creation
  });

  test('cross-tenant: links, lists and ids do not cross institutions', async () => {
    const B = await makeTenant('beta-college');
    const adminA = await createUser({ role: 'ADMIN' });
    const adminB = await createUser({ role: 'ADMIN', tenant: B });
    const a = await loginAgent(app, adminA);
    const b = await loginAgent(app, adminB, PASSWORD, 'beta-college');
    const inviteA = await invite(a);
    const tokenA = tokenOf(inviteA.body.data.link);

    expect((await raw('beta-college').get(`/api/auth/invite?token=${tokenA}`)).status).toBe(400);
    expect((await post(raw('beta-college'), '/api/auth/accept-invite', { token: tokenA, name: 'Cross Person', password: 'MyOwnPass123' })).status).toBe(400);
    expect((await b.get('/api/admin/invites')).body.data.items).toHaveLength(0);
    expect((await b.delete(`/api/admin/invites/${inviteA.body.data.invite._id}`).set(CSRF)).status).toBe(404);
    expect((await post(b, `/api/admin/invites/${inviteA.body.data.invite._id}/resend`)).status).toBe(404);
    expect((await Invite.findOne({})).revokedAt).toBeNull();

    // The same address can be invited at both institutions, independently.
    const inviteB = await invite(b);
    expect(inviteB.status).toBe(201);
    expect(inviteB.body.data.link).toContain('/t/beta-college/');
    expect((await raw().get(`/api/auth/invite?token=${tokenA}`)).status).toBe(200);
    expect(await runAsTenant(B._id, () => Invite.countDocuments({}))).toBe(1);
  });
});

describe('password change', () => {
  test('needs the current password, ends other sessions, keeps this one, and is audited', async () => {
    const user = await createUser({ role: 'STUDENT', email: 'pw@example.com' });
    const phone = await loginAgent(app, user);
    const laptop = await loginAgent(app, user);

    expect((await post(laptop, '/api/auth/change-password', { currentPassword: 'WrongPass123', newPassword: 'BrandNew1234' })).status).toBe(400);
    expect((await post(laptop, '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    expect((await post(laptop, '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await phone.get('/api/auth/me')).status).toBe(200); // nothing changed yet

    const ok = await post(laptop, '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'BrandNew1234' });
    expect(ok.status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(200); // this device keeps working
    expect((await phone.get('/api/auth/me')).status).toBe(401); // the other one is signed out
    expect((await login('pw@example.com', PASSWORD)).status).toBe(401);
    expect((await login('pw@example.com', 'BrandNew1234')).status).toBe(200);
    const log = await AuditLog.findOne({ action: 'PASSWORD_CHANGED' });
    expect(JSON.stringify(log)).not.toMatch(/BrandNew1234|Passw0rdTest/);
    expect((await request(app).post('/api/auth/change-password').set(CSRF).send({})).status).toBe(401);
  });
});

describe('forgot and reset password', () => {
  test('the response is identical whether or not the address has an account, and only real accounts get mail', async () => {
    await createUser({ role: 'STUDENT', email: 'real@example.com' });
    await createUser({ role: 'STUDENT', email: 'off@example.com', isActive: false });
    const answers = [];
    for (const email of ['real@example.com', 'ghost@example.com', 'off@example.com']) {
      const res = await post(raw(), '/api/auth/forgot-password', { email });
      answers.push([res.status, res.body]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual(answers[2]);
    expect(mailer.sent()).toHaveLength(1);
    expect(mailer.sent()[0].to).toBe('real@example.com');
    expect(mailer.sent()[0].data.link).toMatch(/\/t\/default\/reset-password\.html\?token=/);
    expect((await post(raw(), '/api/auth/forgot-password', { email: 'nope' })).status).toBe(400);
  });

  test('a reset link works once, sets the password, ends every session and clears a lockout', async () => {
    const user = await createUser({ role: 'STUDENT', email: 'reset@example.com' });
    const session = await loginAgent(app, user);
    await User.updateOne({ _id: user._id }, { failedLogins: 3, lockedUntil: new Date(Date.now() + 60000) });
    await post(raw(), '/api/auth/forgot-password', { email: 'reset@example.com' });
    const token = tokenOf(mailer.lastTo('reset@example.com').data.link);

    const stored = await AuthToken.findOne({});
    expect(stored.tokenHash).toBe(sha(token));
    expect(JSON.stringify(await AuthToken.collection.find({}).toArray())).not.toContain(token);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThan(61 * 60 * 1000);

    const done = await post(raw(), '/api/auth/reset-password', { token, password: 'FreshStart99' });
    expect(done.status).toBe(200);
    expect((await session.get('/api/auth/me')).status).toBe(401);
    expect((await login('reset@example.com', PASSWORD)).status).toBe(401);
    expect((await login('reset@example.com', 'FreshStart99')).status).toBe(200); // lockout cleared too
    expect((await post(raw(), '/api/auth/reset-password', { token, password: 'AnotherOne77' })).status).toBe(400); // single use
    expect((await login('reset@example.com', 'AnotherOne77')).status).toBe(401);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toMatch(/FreshStart99/);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET' })).toBe(1);
  });

  test('expired, unknown, malformed, superseded and deactivated-user links all fail the same way', async () => {
    const user = await createUser({ role: 'STUDENT', email: 'x@example.com' });
    const gone = await createUser({ role: 'STUDENT', email: 'gone@example.com' });
    await post(raw(), '/api/auth/forgot-password', { email: 'x@example.com' });
    const first = tokenOf(mailer.lastTo('x@example.com').data.link);
    await post(raw(), '/api/auth/forgot-password', { email: 'x@example.com' });
    const second = tokenOf(mailer.lastTo('x@example.com').data.link);
    await post(raw(), '/api/auth/forgot-password', { email: 'gone@example.com' });
    const goneToken = tokenOf(mailer.lastTo('gone@example.com').data.link);
    await User.updateOne({ _id: gone._id }, { isActive: false });

    await AuthToken.updateOne({ tokenHash: sha(second) }, { expiresAt: new Date(Date.now() - 1000) });
    const bodies = new Set();
    for (const token of [first, second, goneToken, crypto.randomBytes(32).toString('base64url'), 'junk', '']) {
      const res = await post(raw(), '/api/auth/reset-password', { token, password: 'FreshStart99' });
      expect(res.status).toBe(400);
      bodies.add(JSON.stringify(res.body.errors ? res.body.errors[0].message : res.body.message));
    }
    expect(bodies.size).toBe(1);
    expect((await login('x@example.com', PASSWORD)).status).toBe(200); // nothing changed
    void user;
  });

  test('a reset link cannot be used at another institution, and weak passwords are refused without burning it', async () => {
    await makeTenant('beta-college');
    await createUser({ role: 'STUDENT', email: 'reset@example.com' });
    await post(raw(), '/api/auth/forgot-password', { email: 'reset@example.com' });
    const token = tokenOf(mailer.lastTo('reset@example.com').data.link);
    expect((await post(raw('beta-college'), '/api/auth/reset-password', { token, password: 'FreshStart99' })).status).toBe(400);
    expect((await post(raw(), '/api/auth/reset-password', { token, password: 'weak' })).status).toBe(400);
    expect((await post(raw(), '/api/auth/reset-password', { token, password: 'FreshStart99' })).status).toBe(200);
  });

  test('the token endpoints are rate limited', async () => {
    const limited = makeApp({ authRateLimitMax: 3 });
    let last;
    for (let i = 0; i < 5; i += 1) last = await request(limited).post('/api/auth/forgot-password').set(CSRF).send({ email: 'a@example.com' });
    expect(last.status).toBe(429);
    last = await request(limited).post('/api/auth/reset-password').set(CSRF).send({ token: 'x'.repeat(43), password: 'FreshStart99' });
    expect(last.status).toBe(429);
  });

  test('an admin-issued reset link works once and is audited without the token', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const user = await createUser({ role: 'CLERK', email: 'locked.out@example.com' });
    const a = await loginAgent(app, admin);
    const res = await post(a, `/api/admin/users/${user._id}/reset-link`);
    expect(res.status).toBe(200);
    const token = tokenOf(res.body.data.link);
    expect((await post(raw(), '/api/auth/reset-password', { token, password: 'FreshStart99' })).status).toBe(200);
    expect((await post(raw(), '/api/auth/reset-password', { token, password: 'FreshStart99' })).status).toBe(400);
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toContain(token);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET_ISSUED' })).toBe(1);
    const c = await loginAgent(app, await createUser({ role: 'CLERK' }));
    expect((await post(c, `/api/admin/users/${user._id}/reset-link`)).status).toBe(403);
  });
});

describe('e-mail verification', () => {
  const register = (email = 'new@example.com') =>
    post(raw(), '/api/auth/register', { name: 'New Student', email, password: PASSWORD, department: 'CSE' });
  const BODY = { documentType: 'Transcript', purpose: 'Needed for a visa application' };

  test('registration sends a link; it verifies once, and an old link dies when a new one is requested', async () => {
    const reg = await register();
    expect(reg.status).toBe(201);
    const first = tokenOf(mailer.lastTo('new@example.com', 'verify-email').data.link);
    expect((await User.findOne({ email: 'new@example.com' })).emailVerifiedAt).toBeNull();

    const agent = await loginAgent(app, await User.findOne({ email: 'new@example.com' }));
    await post(agent, '/api/auth/resend-verification');
    const second = tokenOf(mailer.lastTo('new@example.com', 'verify-email').data.link);
    expect(second).not.toBe(first);
    expect((await post(raw(), '/api/auth/verify-email', { token: first })).status).toBe(400);
    expect((await post(raw(), '/api/auth/verify-email', { token: second })).status).toBe(200);
    expect((await User.findOne({ email: 'new@example.com' })).emailVerifiedAt).toBeTruthy();
    expect((await post(raw(), '/api/auth/verify-email', { token: second })).status).toBe(400);
    expect(JSON.stringify(await AuthToken.collection.find({}).toArray())).not.toContain(second);
  });

  test('when required, an unverified student cannot submit; verifying (or an admin) unlocks it; staff are unaffected', async () => {
    config.requireEmailVerification = true;
    await register();
    const student = await User.findOne({ email: 'new@example.com' });
    const agent = await loginAgent(app, student);
    expect((await agent.get('/api/auth/me')).body.data.verificationRequired).toBe(true);
    const blocked = await post(agent, '/api/requests', BODY);
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/verify/i);
    expect(await require('../models/Request').countDocuments({})).toBe(0);

    await post(raw(), '/api/auth/verify-email', { token: tokenOf(mailer.lastTo('new@example.com', 'verify-email').data.link) });
    expect((await post(agent, '/api/requests', BODY)).status).toBe(201);

    // An admin can mark another student verified (until e-mail delivery exists).
    await register('second@example.com');
    const second = await User.findOne({ email: 'second@example.com' });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const agent2 = await loginAgent(app, second);
    expect((await post(agent2, '/api/requests', BODY)).status).toBe(403);
    expect((await post(admin, `/api/admin/users/${second._id}/verify-email`)).status).toBe(200);
    expect((await post(agent2, '/api/requests', BODY)).status).toBe(201);
  });

  test('by default (no e-mail provider yet) the gate is off', async () => {
    await register();
    const agent = await loginAgent(app, await User.findOne({ email: 'new@example.com' }));
    expect((await post(agent, '/api/requests', BODY)).status).toBe(201);
  });
});

describe('lockout', () => {
  test('five wrong passwords lock the account; the answer never changes; unlocking and expiry restore access', async () => {
    const user = await createUser({ role: 'STUDENT', email: 'lock@example.com' });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push((await login('lock@example.com', 'WrongPass123')).body);
    const locked = await login('lock@example.com', PASSWORD); // correct password, but locked
    const unknown = await login('ghost@example.com', PASSWORD);
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual(answers[0]);
    expect(unknown.body).toEqual(answers[0]); // unknown account is indistinguishable
    expect(await AuditLog.countDocuments({ action: 'ACCOUNT_LOCKED' })).toBe(1);

    const list = await admin.get('/api/admin/users?limit=100');
    expect(list.body.data.items.find((u) => u._id === String(user._id)).locked).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/failedLogins|lockedUntil|tokenVersion/);

    expect((await post(admin, `/api/admin/users/${user._id}/unlock`)).status).toBe(200);
    expect((await login('lock@example.com', PASSWORD)).status).toBe(200);

    // Expiry without an admin.
    for (let i = 0; i < 5; i += 1) await login('lock@example.com', 'WrongPass123');
    expect((await login('lock@example.com', PASSWORD)).status).toBe(401);
    await User.updateOne({ _id: user._id }, { lockedUntil: new Date(Date.now() - 1000) });
    expect((await login('lock@example.com', PASSWORD)).status).toBe(200);
  });

  test('a successful sign-in resets the count, so scattered mistakes never lock anyone', async () => {
    await createUser({ role: 'STUDENT', email: 'careful@example.com' });
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) await login('careful@example.com', 'WrongPass123');
      expect((await login('careful@example.com', PASSWORD)).status).toBe(200);
    }
    expect(await AuditLog.countDocuments({ action: 'ACCOUNT_LOCKED' })).toBe(0);
  });

  test('locking is per account and per institution', async () => {
    const B = await makeTenant('beta-college');
    await createUser({ role: 'STUDENT', email: 'same@example.com' });
    await createUser({ role: 'STUDENT', email: 'same@example.com', tenant: B });
    for (let i = 0; i < 6; i += 1) await login('same@example.com', 'WrongPass123');
    expect((await login('same@example.com', PASSWORD)).status).toBe(401);
    expect((await login('same@example.com', PASSWORD, 'beta-college')).status).toBe(200);
    const adminB = await loginAgent(app, await createUser({ role: 'ADMIN', tenant: B }), PASSWORD, 'beta-college');
    const victim = await User.findOne({ email: 'same@example.com' });
    expect((await post(adminB, `/api/admin/users/${victim._id}/unlock`)).status).toBe(404); // not B's user
  });
});

describe('session revocation', () => {
  test('logout kills the session on the server, so a copied cookie is dead, and signs out other devices', async () => {
    const user = await createUser({ role: 'STUDENT' });
    const res = await login(user.email);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const other = await loginAgent(app, user);
    expect((await raw().get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
    const out = await raw().post('/api/auth/logout').set(CSRF).set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect((await raw().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401); // replaying the copied cookie fails
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  test('deactivation revokes sessions for good: reactivating does not bring an old one back', async () => {
    const user = await createUser({ role: 'STUDENT' });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const old = await loginAgent(app, user);
    await admin.patch(`/api/admin/users/${user._id}`).set(CSRF).send({ isActive: false });
    expect((await old.get('/api/auth/me')).status).toBe(403);
    await admin.patch(`/api/admin/users/${user._id}`).set(CSRF).send({ isActive: true });
    expect((await old.get('/api/auth/me')).status).toBe(401);
    expect((await loginAgent(app, user)).get).toBeDefined();
  });

  test('an admin can sign a user out everywhere; tokens with the wrong or missing version are refused', async () => {
    const user = await createUser({ role: 'STUDENT' });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const a = await loginAgent(app, user);
    expect((await post(admin, `/api/admin/users/${user._id}/sign-out`)).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(401);
    expect(await AuditLog.countDocuments({ action: 'SESSIONS_REVOKED' })).toBe(1);

    const fresh = await loginAgent(app, user);
    expect((await fresh.get('/api/auth/me')).status).toBe(200);
    const stale = forgeToken(user._id, { ver: 0 });
    expect((await raw().get('/api/auth/me').set('Cookie', `${config.cookieName}=${stale}`)).status).toBe(401);
    const noVer = jwt.sign({ sub: String(user._id), tid: String(getDefaultTenant()._id) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    expect((await raw().get('/api/auth/me').set('Cookie', `${config.cookieName}=${noVer}`)).status).toBe(401);
    const c = await loginAgent(app, await createUser({ role: 'CLERK' }));
    expect((await post(c, `/api/admin/users/${user._id}/sign-out`)).status).toBe(403);
  });

  test('cross-tenant: an admin cannot revoke, verify or unlock another institution\'s user', async () => {
    const B = await makeTenant('beta-college');
    const bUser = await createUser({ role: 'STUDENT', tenant: B });
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    const bSession = await loginAgent(app, bUser, PASSWORD, 'beta-college');
    for (const action of ['sign-out', 'verify-email', 'unlock', 'reset-link']) {
      expect([action, (await post(admin, `/api/admin/users/${bUser._id}/${action}`)).status]).toEqual([action, 404]);
    }
    expect((await bSession.get('/api/auth/me')).status).toBe(200);
  });
});

describe('multi-factor authentication', () => {
  async function staffWithMfa({ email = 'mfa@example.com', role = 'CLERK' } = {}) {
    const user = await createUser({ role, email });
    const agent = await loginAgent(app, user);
    const setup = await post(agent, '/api/auth/mfa/setup');
    expect(setup.status).toBe(200);
    const enable = await post(agent, '/api/auth/mfa/enable', { code: totp.generate(setup.body.data.secret) });
    expect(enable.status).toBe(200);
    return { user, agent, secret: setup.body.data.secret, backupCodes: enable.body.data.backupCodes };
  }
  // A code for the NEXT 30 s step: valid (one step of tolerance) and newer than the one used to enrol.
  const nextCode = (secret, steps = 1) => totp.generate(secret, Date.now() + steps * 30000);

  test('enrolment: secret shown once and stored encrypted; a wrong code does not enable; ten hashed backup codes', async () => {
    const user = await createUser({ role: 'HOD', email: 'hod@example.com' });
    const agent = await loginAgent(app, user);
    expect((await post(raw(), '/api/auth/mfa/setup')).status).toBe(401);
    const setup = await post(agent, '/api/auth/mfa/setup');
    const { secret, otpauthUrl } = setup.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const row = await User.findById(user._id).select('+mfaSecret');
    expect(row.mfaSecret).not.toContain(secret);
    expect(mfaService.decrypt(row.mfaSecret)).toBe(secret);
    expect(row.mfaEnabled).toBe(false);

    expect((await post(agent, '/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await post(agent, '/api/auth/mfa/enable', { code: 'abc' })).status).toBe(400);
    expect((await User.findById(user._id)).mfaEnabled).toBe(false);

    const enable = await post(agent, '/api/auth/mfa/enable', { code: totp.generate(secret) });
    expect(enable.body.data.backupCodes).toHaveLength(10);
    expect(new Set(enable.body.data.backupCodes).size).toBe(10);
    for (const c of enable.body.data.backupCodes) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    const full = await User.findById(user._id).select('+mfaBackupCodes');
    expect(full.mfaEnabled).toBe(true);
    expect(JSON.stringify(full.mfaBackupCodes)).not.toContain(enable.body.data.backupCodes[0].replace('-', ''));
    expect(full.mfaBackupCodes[0].hash).toBe(sha(enable.body.data.backupCodes[0].replace('-', '')));
    expect(await AuditLog.countDocuments({ action: 'MFA_ENABLED' })).toBe(1);

    expect((await post(agent, '/api/auth/mfa/setup')).status).toBe(409); // already on
    const me = await agent.get('/api/auth/me');
    expect(me.body.data.user.mfaEnabled).toBe(true);
    expect(JSON.stringify(me.body)).not.toMatch(/mfaSecret|mfaBackupCodes|mfaLastStep/);
  });

  test('students cannot enrol, and nothing works when the server has no MFA key', async () => {
    const student = await loginAgent(app, await createUser({ role: 'STUDENT' }));
    expect((await post(student, '/api/auth/mfa/setup')).status).toBe(403);
    const clerk = await loginAgent(app, await createUser({ role: 'CLERK' }));
    config.mfaKey = '';
    const res = await post(clerk, '/api/auth/mfa/setup');
    expect(res.status).toBe(503);
    expect((await clerk.get('/api/auth/me')).body.data.mfaAvailable).toBe(false);
  });

  test('sign-in is two steps: the password alone gives no session, the code completes it', async () => {
    const { user, secret } = await staffWithMfa();
    const first = await login('mfa@example.com');
    expect(first.status).toBe(200);
    expect(first.body.data.mfaRequired).toBe(true);
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.body.data.user).toBeUndefined();
    const { challenge } = first.body.data;

    // The challenge is not a session, even if someone plants it as the cookie.
    expect((await raw().get('/api/auth/me').set('Cookie', `${config.cookieName}=${challenge}`)).status).toBe(401);

    const wrong = await post(raw(), '/api/auth/login/mfa', { challenge, code: '000000' });
    expect(wrong.status).toBe(401);
    const code = nextCode(secret);
    const done = await post(raw(), '/api/auth/login/mfa', { challenge, code });
    expect(done.status).toBe(200);
    expect(done.body.data.user.email).toBe('mfa@example.com');
    const cookie = done.headers['set-cookie'][0].split(';')[0];
    expect((await raw().get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    // The same code cannot be used twice (replay).
    const again = await post(raw(), '/api/auth/login/mfa', { challenge: (await login('mfa@example.com')).body.data.challenge, code });
    expect(again.status).toBe(401);
    void user;
  });

  test('time-step handling: the code just used and any older step are rejected, a later one works', async () => {
    const { secret } = await staffWithMfa();
    const challenge = async () => (await login('mfa@example.com')).body.data.challenge;
    // Enrolment consumed the current step; one step back is therefore refused.
    expect((await post(raw(), '/api/auth/login/mfa', { challenge: await challenge(), code: totp.generate(secret, Date.now() - 30000) })).status).toBe(401);
    expect((await post(raw(), '/api/auth/login/mfa', { challenge: await challenge(), code: totp.generate(secret) })).status).toBe(401);
    const ok = await atOffset(60000, async () => post(raw(), '/api/auth/login/mfa', { challenge: await challenge(), code: totp.generate(secret, Date.now()) }));
    expect(ok.status).toBe(200);
  });

  test('backup codes work once each, with or without the dash, and are case-insensitive', async () => {
    const { backupCodes } = await staffWithMfa();
    const challenge = async () => (await login('mfa@example.com')).body.data.challenge;
    const use = async (code) => post(raw(), '/api/auth/login/mfa', { challenge: await challenge(), code });
    expect((await use(backupCodes[0])).status).toBe(200);
    expect((await use(backupCodes[0])).status).toBe(401);
    expect((await use(backupCodes[1].replace('-', ''))).status).toBe(200);
    expect((await use(backupCodes[2].toUpperCase())).status).toBe(200);
    expect((await use('aaaaa-bbbbb')).status).toBe(401);
  });

  test('wrong codes count towards the lockout, and a locked account refuses even the right code', async () => {
    const { secret } = await staffWithMfa();
    const { challenge } = (await login('mfa@example.com')).body.data;
    for (let i = 0; i < 5; i += 1) expect((await post(raw(), '/api/auth/login/mfa', { challenge, code: '000000' })).status).toBe(401);
    const res = await post(raw(), '/api/auth/login/mfa', { challenge, code: nextCode(secret) });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
    expect(await AuditLog.countDocuments({ action: 'ACCOUNT_LOCKED' })).toBe(1);
  });

  test('forged, expired, cross-institution and outdated challenges are refused', async () => {
    const { user, secret } = await staffWithMfa();
    const tid = String(getDefaultTenant()._id);
    const sign = (claims, opts = {}) => jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m', ...opts });
    const code = nextCode(secret);
    const cases = {
      noMfaClaim: sign({ sub: String(user._id), tid, ver: 0 }),
      wrongSecret: jwt.sign({ sub: String(user._id), tid, ver: 0, mfa: true }, 'another-secret-another-secret-another-1', { algorithm: 'HS256' }),
      expired: sign({ sub: String(user._id), tid, ver: 0, mfa: true }, { expiresIn: -10 }),
      oldVersion: sign({ sub: String(user._id), tid, ver: 99, mfa: true }),
      otherTenant: sign({ sub: String(user._id), tid: String((await makeTenant('beta-college'))._id), ver: 0, mfa: true }),
      garbage: 'x'.repeat(40),
    };
    for (const [name, challenge] of Object.entries(cases)) {
      expect([name, (await post(raw(), '/api/auth/login/mfa', { challenge, code })).status]).toEqual([name, 401]);
    }
    // A challenge from the right place, but issued before a password change, is useless too.
    const { challenge } = (await login('mfa@example.com')).body.data;
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    expect((await post(raw(), '/api/auth/login/mfa', { challenge, code })).status).toBe(401);
  });

  test('turning it off needs the password and a code, ends sessions, and restores one-step sign-in', async () => {
    const { agent, secret, backupCodes } = await staffWithMfa();
    expect((await post(agent, '/api/auth/mfa/disable', { password: 'WrongPass123', code: backupCodes[0] })).status).toBe(400);
    expect((await post(agent, '/api/auth/mfa/disable', { password: PASSWORD, code: '000000' })).status).toBe(400);
    expect((await User.findOne({ email: 'mfa@example.com' })).mfaEnabled).toBe(true);
    const off = await post(agent, '/api/auth/mfa/disable', { password: PASSWORD, code: nextCode(secret) });
    expect(off.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const row = await User.findOne({ email: 'mfa@example.com' }).select('+mfaSecret +mfaBackupCodes');
    expect(row).toMatchObject({ mfaEnabled: false, mfaSecret: null });
    expect(row.mfaBackupCodes).toHaveLength(0);
    expect((await login('mfa@example.com')).body.data.user).toBeDefined(); // a normal session again
    expect(await AuditLog.countDocuments({ action: 'MFA_DISABLED' })).toBe(1);
  });

  test('an MFA-enabled user still needs the code when the server key is missing (fails closed)', async () => {
    await staffWithMfa();
    config.mfaKey = '';
    const first = await login('mfa@example.com');
    expect(first.body.data.mfaRequired).toBe(true);
    const res = await post(raw(), '/api/auth/login/mfa', { challenge: first.body.data.challenge, code: '123456' });
    expect(res.status).toBe(401);
  });

  test('cross-tenant: a challenge from one institution cannot be answered at another', async () => {
    const B = await makeTenant('beta-college');
    const { secret } = await staffWithMfa();
    await createUser({ role: 'CLERK', email: 'mfa@example.com', tenant: B });
    const { challenge } = (await login('mfa@example.com')).body.data;
    expect((await post(raw('beta-college'), '/api/auth/login/mfa', { challenge, code: nextCode(secret) })).status).toBe(401);
    expect((await login('mfa@example.com', PASSWORD, 'beta-college')).body.data.user).toBeDefined(); // B's user has no MFA
    void runUnscoped;
  });
});

describe('invited staff join the existing workflow', () => {
  test('an invited Clerk and HOD work a request end to end', async () => {
    const admin = await loginAgent(app, await createUser({ role: 'ADMIN' }));
    expect((await addStaff(app, admin, { name: 'Clerk One', email: 'c1@example.com', role: 'CLERK', department: 'CSE' })).status).toBe(201);
    expect((await addStaff(app, admin, { name: 'Hod One', email: 'h1@example.com', role: 'HOD', department: 'CSE' })).status).toBe(201);
    const student = await loginAgent(app, await createUser({ role: 'STUDENT', department: 'CSE' }));
    const clerk = await loginAgent(app, await User.findOne({ email: 'c1@example.com' }), 'StaffPass123');
    const hod = await loginAgent(app, await User.findOne({ email: 'h1@example.com' }), 'StaffPass123');
    const id = (await post(student, '/api/requests', { documentType: 'Transcript', purpose: 'Needed for a visa application' })).body.data.request._id;
    expect((await clerk.patch(`/api/requests/${id}/advance`).set(CSRF)).status).toBe(200);
    expect((await hod.patch(`/api/requests/${id}/advance`).set(CSRF)).body.data.request.status).toBe('APPROVED');
  });
});
