'use strict';

// S4: the storage interface (local and S3-compatible adapters), request signing, the malware
// scanner client and the new configuration guards. No database needed.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sign, sha256Hex, uriEncode } = require('../storage/sigv4');
const LocalAdapter = require('../storage/localAdapter');
const S3Adapter = require('../storage/s3Adapter');
const { StorageError, KEY_PATTERN } = require('../storage/errors');
const { makeKey } = require('../storage');
const scanner = require('../services/scanner');
const config = require('../config/env');
const { startFakeS3, startFakeClamd, closedPort, EICAR, FAKE_S3 } = require('./fakes');

const TENANT = 'a'.repeat(24);
const REQUEST = 'b'.repeat(24);
const key = (ext = 'pdf') => makeKey(TENANT, REQUEST, ext);
const PDF = Buffer.from('%PDF-1.4\nstorage test\n%%EOF\n');
const readAll = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

describe('AWS Signature V4 (unit)', () => {
  // The examples published in the AWS S3 documentation ("Signature Calculations for the
  // Authorization Header"). If the signer were wrong, these would not match.
  const aws = { accessKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'), host: 'examplebucket.s3.amazonaws.com' };

  test('(unit) GET object with a Range header matches the AWS example', () => {
    const r = sign({ ...aws, method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: sha256Hex('') });
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(r.headers.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
  });

  test('(unit) PUT object with a special character in the key matches the AWS example', () => {
    const body = 'Welcome to Amazon S3.';
    const r = sign({
      ...aws, method: 'PUT', path: '/test$file.text',
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: sha256Hex(body),
    });
    expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  test('(unit) a listing with query parameters matches the AWS example', () => {
    const r = sign({ ...aws, method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: sha256Hex('') });
    expect(r.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  test('(unit) any change to the request changes the signature; encoding follows RFC 3986', () => {
    const base = { ...aws, method: 'GET', path: '/a', payloadHash: sha256Hex('') };
    const sig = sign(base).signature;
    expect(sign({ ...base, path: '/b' }).signature).not.toBe(sig);
    expect(sign({ ...base, method: 'HEAD' }).signature).not.toBe(sig);
    expect(sign({ ...base, region: 'auto' }).signature).not.toBe(sig);
    expect(sign({ ...base, secretAccessKey: 'other' }).signature).not.toBe(sig);
    expect(uriEncode("a b!'()*/")).toBe('a%20b%21%27%28%29%2A%2F');
  });
});

describe('storage keys (unit)', () => {
  test('(unit) keys are tenant-prefixed, random and match the strict layout', () => {
    const a = key();
    expect(a).toMatch(KEY_PATTERN);
    expect(a.startsWith(`${TENANT}/${REQUEST}/`)).toBe(true);
    expect(key()).not.toBe(a);
  });
});

// The same behavioural contract, run against both adapters.
describe.each([
  ['local', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-store-'));
    return { adapter: new LocalAdapter(dir), cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
  }],
  ['s3', async () => {
    const fake = await startFakeS3({ pageSize: 2 });
    return { adapter: new S3Adapter(fake.config), fake, cleanup: () => fake.close() };
  }],
])('storage adapter contract: %s', (_name, make) => {
  let ctx;
  beforeEach(async () => {
    ctx = await make();
  });
  afterEach(() => ctx.cleanup());

  test('put, get, exists and delete round trip', async () => {
    const k = key();
    expect(await ctx.adapter.exists(k)).toBe(false);
    await ctx.adapter.put(k, PDF);
    expect(await ctx.adapter.exists(k)).toBe(true);
    const { stream, size } = await ctx.adapter.get(k);
    expect(size).toBe(PDF.length);
    expect((await readAll(stream)).equals(PDF)).toBe(true);
    await ctx.adapter.delete(k);
    expect(await ctx.adapter.exists(k)).toBe(false);
    await ctx.adapter.delete(k); // deleting again is harmless
  });

  test('a missing object is NOT_FOUND', async () => {
    await expect(ctx.adapter.get(key())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('SECURITY: anything that is not a well-formed key is refused before any I/O', async () => {
    const bad = ['../../etc/passwd', '/etc/passwd', 'C:\\Windows\\win.ini', 'abc.pdf', `${TENANT}/${REQUEST}/../x.pdf`, `${TENANT}/${REQUEST}/${crypto.randomUUID()}.exe`,
      `${TENANT.toUpperCase()}/${REQUEST}/${crypto.randomUUID()}.pdf`, '', null, undefined, 42, `${TENANT}/${REQUEST}/${crypto.randomUUID()}.pdf/extra`];
    for (const k of bad) {
      for (const op of ['put', 'get', 'exists', 'delete']) {
        await expect(ctx.adapter[op](k, PDF)).rejects.toBeInstanceOf(StorageError);
        await expect(ctx.adapter[op](k, PDF)).rejects.toMatchObject({ code: 'INVALID_KEY' });
      }
    }
  });

  test('list returns every object with size and time, across pages', async () => {
    const keys = [key(), key('png'), key('jpg'), key(), key()];
    for (const k of keys) await ctx.adapter.put(k, PDF);
    const listed = await ctx.adapter.list();
    expect(listed.map((f) => f.key).sort()).toEqual([...keys].sort());
    expect(listed.every((f) => f.size === PDF.length && typeof f.modifiedAt.getTime() === 'number')).toBe(true);
  });

  test('check passes for a usable store', async () => {
    await expect(ctx.adapter.check()).resolves.toBeUndefined();
  });

  test('deleteRaw removes legacy (non-layout) names too, but never escapes the store', async () => {
    if (ctx.adapter.name === 'local') {
      fs.writeFileSync(path.join(ctx.adapter.root, 'legacy.pdf'), PDF);
      await ctx.adapter.deleteRaw('legacy.pdf');
      expect(fs.existsSync(path.join(ctx.adapter.root, 'legacy.pdf'))).toBe(false);
      await expect(ctx.adapter.deleteRaw('../outside.txt')).rejects.toMatchObject({ code: 'INVALID_KEY' });
    } else {
      ctx.fake.objects.set('legacy.pdf', { body: PDF, modifiedAt: new Date() });
      await ctx.adapter.deleteRaw('legacy.pdf');
      expect(ctx.fake.objects.has('legacy.pdf')).toBe(false);
    }
  });
});

describe('local adapter specifics', () => {
  test('files are written once, privately, and never overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-store-'));
    try {
      const a = new LocalAdapter(dir);
      const k = key();
      await a.put(k, PDF);
      await expect(a.put(k, Buffer.from('other'))).rejects.toThrow(); // flag "wx"
      expect(fs.readFileSync(path.join(dir, ...k.split('/'))).equals(PDF)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, ...k.split('/'))).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S3 adapter specifics', () => {
  test('requests are signed with the right credentials: a wrong secret or key is refused (403) and nothing leaks', async () => {
    const fake = await startFakeS3();
    try {
      const wrongSecret = new S3Adapter({ ...fake.config, secretAccessKey: 'wrong-secret-wrong-secret-wrong-secret' });
      await expect(wrongSecret.put(key(), PDF)).rejects.toMatchObject({ code: 'FAILED' });
      const wrongKey = new S3Adapter({ ...fake.config, accessKeyId: 'AKIA' + 'WRONGWRONGWRONG00' });
      await expect(wrongKey.check()).rejects.toMatchObject({ code: 'FAILED' });
      expect(fake.objects.size).toBe(0);
      const err = await wrongSecret.put(key(), PDF).catch((e) => e);
      expect(err.message).not.toMatch(/wrong-secret|SignatureDoesNotMatch|AKIA/);
    } finally {
      await fake.close();
    }
  });

  test('objects go to the right bucket, path and content type; the payload hash is verified', async () => {
    const fake = await startFakeS3();
    try {
      const a = new S3Adapter(fake.config);
      const k = key('png');
      await a.put(k, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      expect(fake.log.at(-1)).toMatchObject({ method: 'PUT', path: `/${FAKE_S3.bucket}/${k}` });
      expect(fake.objects.get(k).contentType).toBe('image/png');
    } finally {
      await fake.close();
    }
  });

  test('provider errors become FAILED with a generic message (no provider text, no secrets)', async () => {
    const fake = await startFakeS3();
    try {
      const a = new S3Adapter(fake.config);
      fake.state.failNext = 1;
      const err = await a.put(key(), PDF).catch((e) => e);
      expect(err).toMatchObject({ code: 'FAILED' });
      expect(err.message).not.toMatch(/secret-detail/);
      fake.state.failNext = 1;
      await expect(a.get(key())).rejects.toMatchObject({ code: 'FAILED' });
      fake.state.failNext = 1;
      await expect(a.exists(key())).rejects.toMatchObject({ code: 'FAILED' });
      fake.state.failNext = 1;
      await expect(a.list()).rejects.toMatchObject({ code: 'FAILED' });
    } finally {
      await fake.close();
    }
  });

  test('an unreachable store is an error, not a hang', async () => {
    const port = await closedPort();
    const a = new S3Adapter({ ...FAKE_S3, endpoint: `http://127.0.0.1:${port}`, bucket: FAKE_S3.bucket });
    await expect(a.check()).rejects.toThrow();
  });
});

describe('malware scanner client', () => {
  const saved = { ...config.clamd };
  let mode0;
  beforeEach(() => {
    mode0 = config.scanMode;
  });
  afterEach(() => {
    config.scanMode = mode0;
    Object.assign(config.clamd, saved);
  });

  test('clean and infected files are reported; the file is sent in INSTREAM chunks, byte for byte', async () => {
    const clam = await startFakeClamd();
    try {
      Object.assign(config.clamd, { host: '127.0.0.1', port: clam.port, timeoutMs: 3000 });
      config.scanMode = 'required';
      expect(await scanner.scan(PDF)).toEqual({ status: 'clean' });
      const infected = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR)]);
      expect(await scanner.scan(infected)).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(200 * 1024)]); // several 64 KB chunks
      expect(await scanner.scan(big)).toEqual({ status: 'clean' });
      expect(clam.state.received[2].equals(big)).toBe(true);
      expect(clam.state.scans).toBe(3);
    } finally {
      await clam.close();
    }
  });

  test('off never calls the scanner', async () => {
    const clam = await startFakeClamd();
    try {
      Object.assign(config.clamd, { host: '127.0.0.1', port: clam.port });
      config.scanMode = 'off';
      expect(await scanner.scan(PDF)).toEqual({ status: 'skipped' });
      expect(clam.state.scans).toBe(0);
    } finally {
      await clam.close();
    }
  });

  test.each([
    ['daemon down', async () => ({ port: await closedPort(), close: async () => {} })],
    ['daemon hangs', async () => startFakeClamd({ mode: 'hang' })],
    ['daemon error reply', async () => startFakeClamd({ mode: 'error' })],
    ['daemon garbage reply', async () => startFakeClamd({ mode: 'garbage' })],
  ])('%s: required fails closed (503), optional lets the file through', async (_label, start) => {
    const clam = await start();
    try {
      Object.assign(config.clamd, { host: '127.0.0.1', port: clam.port, timeoutMs: 400 });
      config.scanMode = 'required';
      await expect(scanner.scan(PDF)).rejects.toMatchObject({ status: 503 });
      config.scanMode = 'optional';
      expect(await scanner.scan(PDF)).toEqual({ status: 'unavailable' });
    } finally {
      await clam.close();
    }
  });
});

describe('storage and scanning configuration guards (unit)', () => {
  function load(env) {
    const saved = { ...process.env };
    const blank = { MAIL_PROVIDER: '', PUBLIC_URL: 'https://docflow.example.com', STORAGE_DRIVER: '', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', S3_REGION: '', SCAN_MODE: '', CLAMD_HOST: '', DOCUMENT_RETENTION_DAYS: '', VERIFY_SIGNING_KEY: '', HOST: '', TRUST_PROXY: '', UPLOAD_DIR: '' };
    Object.assign(process.env, blank, env);
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
  const s3 = { STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_BUCKET: 'docflow-docs', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' };
  const prod = { NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://example.invalid/db' };

  test('(unit) defaults: local storage, scanning off in development, required in production', () => {
    const dev = load({ NODE_ENV: 'development' });
    expect(dev).toMatchObject({ storageDriver: 'local', scanMode: 'off', retentionDays: 30 });
    expect(() => load({ ...prod })).toThrow(/CLAMD_HOST/); // production must choose: a daemon, or an explicit off
    expect(load({ ...prod, CLAMD_HOST: 'clamav.internal' }).scanMode).toBe('required');
    expect(load({ ...prod, SCAN_MODE: 'off' }).scanMode).toBe('off');
  });

  test('(unit) scanning settings are validated', () => {
    expect(() => load({ SCAN_MODE: 'maybe' })).toThrow(/SCAN_MODE/);
    expect(() => load({ SCAN_MODE: 'optional' })).toThrow(/CLAMD_HOST/);
    expect(load({ SCAN_MODE: 'optional', CLAMD_HOST: 'localhost' }).clamd).toMatchObject({ host: 'localhost', port: 3310 });
  });

  test('(unit) S3 settings are required and validated, https is required in production', () => {
    expect(load(s3).s3).toMatchObject({ bucket: 'docflow-docs', region: 'auto' });
    expect(() => load({ ...s3, S3_BUCKET: '' })).toThrow(/S3_BUCKET/);
    expect(() => load({ ...s3, S3_SECRET_ACCESS_KEY: '' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => load({ ...s3, S3_ENDPOINT: 'https://x.example.com/bucket' })).toThrow(/origin/);
    expect(() => load({ ...s3, S3_BUCKET: 'Bad Bucket!' })).toThrow(/bucket/);
    expect(() => load({ ...s3, ...prod, S3_ENDPOINT: 'http://acct.example.com', SCAN_MODE: 'off' })).toThrow(/https/);
    expect(load({ ...s3, ...prod, SCAN_MODE: 'off' }).storageDriver).toBe('s3');
    expect(() => load({ STORAGE_DRIVER: 'ftp' })).toThrow(/STORAGE_DRIVER/);
  });

  test('(unit) retention and verification key', () => {
    expect(() => load({ DOCUMENT_RETENTION_DAYS: '0.5' })).toThrow(/DOCUMENT_RETENTION_DAYS/);
    expect(load({ DOCUMENT_RETENTION_DAYS: '7' }).retentionDays).toBe(7);
    expect(() => load({ VERIFY_SIGNING_KEY: 'short' })).toThrow(/VERIFY_SIGNING_KEY/);
    expect(load({ VERIFY_SIGNING_KEY: 'k'.repeat(32) }).verifyKey).toHaveLength(32);
  });
});
