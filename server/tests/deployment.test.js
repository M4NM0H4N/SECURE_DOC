'use strict';

// Production-readiness behaviour: configuration guards, health check, reverse-proxy
// handling and upload-folder preparation. Uses only the local test database.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { startDb, stopDb, makeApp, CSRF, request } = require('./helpers');
const { isLocalMongoUri } = require('../config/mongoUri');
const { prepareUploadDir } = require('../config/storage');

const STRONG_SECRET = 'a'.repeat(48);
// Credential-free on purpose: nothing here may look like a real connection string.
const ATLAS_LIKE = 'mongodb+srv://cluster0.example.mongodb.net/prod_db?retryWrites=true';

// Loads server/config/env.js fresh with the given environment, then restores it.
// Empty strings (not deletions) are used for "unset" because dotenv would refill a
// deleted key from the developer's real .env file.
function loadEnv(overrides) {
  const saved = { ...process.env };
  Object.assign(process.env, { HOST: '', TRUST_PROXY: '', UPLOAD_DIR: '', PUBLIC_URL: 'https://docflow.example.com', ...overrides });
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

// Built at runtime so no credential-shaped string is stored in the repository.
const creds = (user, secret, host) => 'mongodb://' + user + ':' + secret + '@' + host + '/db';

describe('isLocalMongoUri (unit)', () => {
  test.each([
    ['mongodb://localhost:27017/db?replicaSet=rs0', true],
    ['mongodb://127.0.0.1:27018/db', true],
    [creds('user', 'x', 'localhost'), true],
    ['mongodb://[::1]:27017/db', true],
    ['mongodb://localhost:27017,127.0.0.1:27018/db', true],
  ])('local: %s', (uri, expected) => {
    expect(isLocalMongoUri(uri)).toBe(expected);
  });

  test.each([
    ATLAS_LIKE,
    'mongodb://cluster0-shard-00-00.example.mongodb.net:27017/db',
    'mongodb://localhost.evil.example.com:27017/db',
    'mongodb://evil.example.com/localhost',
    creds('user', 'localhost', 'evil.example.com'),
    'mongodb://localhost:27017,evil.example.com:27017/db',
    'mongodb://',
    'not a uri',
    '',
    undefined,
    null,
  ])('NOT local: %s', (uri) => {
    expect(isLocalMongoUri(uri)).toBe(false);
  });
});

describe('production configuration guards (unit)', () => {
  const prod = { NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET, MONGODB_URI: ATLAS_LIKE };

  test('development defaults keep local behaviour unchanged', () => {
    const cfg = loadEnv({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost:27017/x' });
    expect(cfg.isProd).toBe(false);
    expect(cfg.host).toBeUndefined();
    expect(cfg.trustProxy).toBe(0);
    expect(cfg.uploadDirIsDefault).toBe(true);
  });

  test('production binds 0.0.0.0, trusts one proxy hop and reads the Atlas URI from the environment', () => {
    const cfg = loadEnv(prod);
    expect(cfg.isProd).toBe(true);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.trustProxy).toBe(1);
    expect(cfg.mongoUri).toBe(ATLAS_LIKE);
  });

  test('HOST and TRUST_PROXY can be overridden; PORT comes from the environment', () => {
    const cfg = loadEnv({ ...prod, HOST: '127.0.0.1', TRUST_PROXY: '2', PORT: '10000' });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.trustProxy).toBe(2);
    expect(cfg.port).toBe(10000);
  });

  test('SECURITY: production refuses a local MongoDB URI and does not echo it', () => {
    const local = 'mongodb://localhost:27017/secure_doc_workflow?replicaSet=rs0';
    let message = '';
    try {
      loadEnv({ ...prod, MONGODB_URI: local });
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/local MongoDB/);
    expect(message).not.toContain('27017');
  });

  test('a connection string with stray whitespace gets a clear error and is not echoed', () => {
    let message = '';
    try {
      loadEnv({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost:27017/x ?replicaSet=rs0' });
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/whitespace/);
    expect(message).not.toContain('27017');
    expect(() => loadEnv({ ...prod, MONGODB_URI: ATLAS_LIKE.replace('cluster0', 'cluster0 ') })).toThrow(/whitespace/);
  });

  test('SECURITY: production requires MONGODB_URI', () => {
    expect(() => loadEnv({ ...prod, MONGODB_URI: '' })).toThrow(/MONGODB_URI is required in production/);
  });

  test('SECURITY: the example JWT secret from .env.example and short secrets are refused', () => {
    expect(() => loadEnv({ ...prod, JWT_SECRET: 'replace_with_long_random_string' })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...prod, JWT_SECRET: 'too-short' })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...prod, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  test.each(['true', '1.5', 'yes', '-1'])('TRUST_PROXY=%s is rejected (only whole hop counts are allowed)', (value) => {
    expect(() => loadEnv({ ...prod, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });

  test('TRUST_PROXY=false disables proxy trust even in production', () => {
    expect(loadEnv({ ...prod, TRUST_PROXY: 'false' }).trustProxy).toBe(0);
  });

  test('uploadDirIsDefault is false when UPLOAD_DIR is set (persistent disk path)', () => {
    const cfg = loadEnv({ ...prod, UPLOAD_DIR: path.join(os.tmpdir(), 'persistent-disk-sim') });
    expect(cfg.uploadDirIsDefault).toBe(false);
  });
});

describe('prepareUploadDir (unit)', () => {
  test('creates the folder and reports no ephemeral risk outside production', () => {
    const dir = path.join(os.tmpdir(), `sdw-upload-check-${Date.now()}`);
    try {
      const res = prepareUploadDir({ uploadDir: dir, isProd: false, uploadDirIsDefault: true });
      expect(fs.existsSync(dir)).toBe(true);
      expect(res.ephemeralRisk).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('warns (ephemeralRisk) in production when UPLOAD_DIR was not set, not when it was', () => {
    const dir = path.join(os.tmpdir(), `sdw-upload-check-prod-${Date.now()}`);
    try {
      expect(prepareUploadDir({ uploadDir: dir, isProd: true, uploadDirIsDefault: true }).ephemeralRisk).toBe(true);
      expect(prepareUploadDir({ uploadDir: dir, isProd: true, uploadDirIsDefault: false }).ephemeralRisk).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails fast when the upload path cannot be used (a file is in the way)', () => {
    const file = path.join(os.tmpdir(), `sdw-not-a-dir-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    try {
      expect(() => prepareUploadDir({ uploadDir: file, isProd: false, uploadDirIsDefault: false })).toThrow();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('health check and reverse-proxy handling (integration)', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  test('GET /healthz is public, returns ok while the database is connected, and is not cached', async () => {
    const res = await request(makeApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('GET /healthz reports 503 when the database is not connected, and leaks no details', async () => {
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 0 });
    try {
      const res = await request(makeApp()).get('/healthz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      delete mongoose.connection.readyState;
    }
    expect((await request(makeApp()).get('/healthz')).status).toBe(200);
  });

  test('health checks are never rate limited', async () => {
    const app = makeApp({ apiRateLimitMax: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/healthz')).status).toBe(200);
    }
  });

  test('behind one trusted proxy, rate limits are tracked per real client IP', async () => {
    const app = makeApp({ trustProxy: 1, authRateLimitMax: 2 });
    const bad = { email: 'nobody@example.com', password: 'WrongPass1' };
    const attempt = (ip) => request(app).post('/api/auth/login').set(CSRF).set('X-Forwarded-For', ip).send(bad);

    expect((await attempt('203.0.113.5')).status).toBe(401);
    expect((await attempt('203.0.113.5')).status).toBe(401);
    expect((await attempt('203.0.113.5')).status).toBe(429); // client A is limited...
    expect((await attempt('203.0.113.9')).status).toBe(401); // ...client B is not
  });
});
