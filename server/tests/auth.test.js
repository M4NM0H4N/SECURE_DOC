'use strict';

process.env.NODE_ENV = 'test';
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, forgeToken, request } = require('./helpers');
const User = require('../models/User');
const authService = require('../services/authService');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

const validReg = {
  name: 'Asha Rao',
  email: 'Asha@Example.com',
  password: 'Passw0rdOK',
  department: 'CSE',
};

describe('password hashing (unit)', () => {
  test('hashes and verifies; never stores plaintext', async () => {
    const hash = await authService.hashPassword('Secret123');
    expect(hash).not.toContain('Secret123');
    expect(await authService.verifyPassword('Secret123', hash)).toBe(true);
    expect(await authService.verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('registration', () => {
  test('creates a STUDENT with lowercase email and no password in response', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).send(validReg);
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('STUDENT');
    expect(res.body.data.user.email).toBe('asha@example.com');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Passw0rdOK/);
    const stored = await User.findOne({ email: 'asha@example.com' }).select('+passwordHash');
    expect(stored.passwordHash).not.toBe('Passw0rdOK');
  });

  test('SECURITY: student cannot register as ADMIN (role ignored)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set(CSRF)
      .send({ ...validReg, role: 'ADMIN', isActive: true });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('STUDENT');
    expect(await User.countDocuments({ role: 'ADMIN' })).toBe(0);
  });

  test('rejects duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').set(CSRF).send(validReg);
    const res = await request(app).post('/api/auth/register').set(CSRF).send(validReg);
    expect(res.status).toBe(409);
  });

  test.each([
    ['invalid email', { email: 'not-an-email' }],
    ['weak password (too short)', { password: 'a1' }],
    ['password without number', { password: 'onlyletters' }],
    ['missing name', { name: undefined }],
    ['unknown department', { department: 'XYZ' }],
    ['missing department', { department: undefined }],
    ['object injected as email', { email: { $ne: '' } }],
  ])('validation: %s -> 400', async (_label, override) => {
    const res = await request(app)
      .post('/api/auth/register')
      .set(CSRF)
      .send({ ...validReg, ...override });
    expect(res.status).toBe(400);
  });
});

describe('login / logout / me', () => {
  test('logs in, sets HttpOnly SameSite=Strict cookie, /me works', async () => {
    const user = await createUser({ email: 'stu@example.com' });
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').set(CSRF).send({ email: user.email, password: 'Passw0rdTest' });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.body.token).toBeUndefined();
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe('stu@example.com');
  });

  test('wrong password and unknown email give the same 401', async () => {
    const user = await createUser({ email: 'stu2@example.com' });
    const a = await request(app).post('/api/auth/login').set(CSRF).send({ email: user.email, password: 'WrongPass1' });
    const b = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'nobody@example.com', password: 'WrongPass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  test('SECURITY: NoSQL operator payload in login is rejected', async () => {
    await createUser({ email: 'victim@example.com' });
    const res = await request(app)
      .post('/api/auth/login')
      .set(CSRF)
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
  });

  test('SECURITY: deactivated user cannot log in', async () => {
    const user = await createUser({ isActive: false, email: 'off@example.com' });
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ email: user.email, password: 'Passw0rdTest' });
    expect(res.status).toBe(403);
  });

  test('SECURITY: deactivated user with a still-valid token is blocked', async () => {
    const user = await createUser({ email: 'later@example.com' });
    const agent = await loginAgent(app, user);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await User.updateOne({ _id: user._id }, { isActive: false });
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(403);
  });

  test('logout clears the cookie', async () => {
    const user = await createUser({ email: 'out@example.com' });
    const agent = await loginAgent(app, user);
    const res = await agent.post('/api/auth/logout').set(CSRF);
    expect(res.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('token handling', () => {
  test('SECURITY: missing token -> 401', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  test('SECURITY: garbage JWT -> 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', 'sdw_token=not.a.jwt');
    expect(res.status).toBe(401);
  });

  test('SECURITY: JWT signed with wrong secret -> 401', async () => {
    const user = await createUser();
    const token = forgeToken(user._id, { secret: 'a-completely-different-secret-value-1234567' });
    const res = await request(app).get('/api/auth/me').set('Cookie', `sdw_token=${token}`);
    expect(res.status).toBe(401);
  });

  test('SECURITY: expired JWT -> 401', async () => {
    const user = await createUser();
    const token = forgeToken(user._id, { expiresIn: -10 });
    const res = await request(app).get('/api/auth/me').set('Cookie', `sdw_token=${token}`);
    expect(res.status).toBe(401);
  });

  test('SECURITY: token for a deleted user -> 401', async () => {
    const user = await createUser();
    const token = forgeToken(user._id);
    await User.deleteOne({ _id: user._id });
    const res = await request(app).get('/api/auth/me').set('Cookie', `sdw_token=${token}`);
    expect(res.status).toBe(401);
  });
});

describe('CSRF header', () => {
  test('SECURITY: state-changing request without header -> 403', async () => {
    const res = await request(app).post('/api/auth/register').send(validReg);
    expect(res.status).toBe(403);
  });
});
