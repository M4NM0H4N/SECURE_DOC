'use strict';

process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, request } = require('./helpers');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const auditService = require('../services/auditService');
const { detectType } = require('../services/documentService');

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const TXT = Buffer.from('This is just text pretending to be a PDF document.');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);

const uploadDir = () => process.env.UPLOAD_DIR;
const storedFiles = () => (fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : []);

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fs.rmSync(uploadDir(), { recursive: true, force: true });
});
afterEach(() => jest.restoreAllMocks());

async function setup(dept = 'CSE', status = 'APPROVED') {
  const student = await createUser({ role: 'STUDENT', department: dept });
  const clerk = await createUser({ role: 'CLERK', department: dept });
  const hod = await createUser({ role: 'HOD', department: dept });
  const r = await createRequest(student, { status });
  return {
    student, clerk, hod, r,
    studentAgent: await loginAgent(app, student),
    clerkAgent: await loginAgent(app, clerk),
    hodAgent: await loginAgent(app, hod),
  };
}

const upload = (agent, id, buf, filename = 'letter.pdf', field = 'document') =>
  agent.post(`/api/requests/${id}/document`).set(CSRF).attach(field, buf, { filename });

describe('signature detection (unit)', () => {
  test('recognises PDF, PNG and JPEG by magic bytes only', () => {
    expect(detectType(PDF)).toBe('pdf');
    expect(detectType(PNG)).toBe('png');
    expect(detectType(JPG)).toBe('jpg');
    expect(detectType(TXT)).toBeNull();
    expect(detectType(EXE)).toBeNull();
    expect(detectType(Buffer.alloc(0))).toBeNull();
  });
});

describe('POST /api/requests/:id/document (upload and fulfil)', () => {
  test.each([
    ['PDF', PDF, 'certificate.pdf', 'pdf'],
    ['PNG', PNG, 'scan.png', 'png'],
    ['JPG', JPG, 'photo.jpg', 'jpg'],
    ['JPEG extension', JPG, 'photo.JPEG', 'jpg'],
  ])('clerk uploads a %s: request becomes FULFILLED with a random private filename', async (_l, buf, name, ext) => {
    const { r, clerkAgent } = await setup();
    const res = await upload(clerkAgent, r._id, buf, name);
    expect(res.status).toBe(200);
    expect(res.body.data.request.status).toBe('FULFILLED');
    expect(JSON.stringify(res.body)).not.toMatch(/documentPath|\.pdf"|\.png"|\.jpg"/);

    const stored = await Request.findById(r._id).select('+documentPath');
    expect(stored.documentPath).toMatch(new RegExp(`^[0-9a-f-]{36}\\.${ext}$`));
    expect(stored.documentPath).not.toContain(name.split('.')[0]);
    expect(storedFiles()).toEqual([stored.documentPath]);
    expect(fs.readFileSync(path.join(uploadDir(), stored.documentPath)).equals(buf)).toBe(true);
    expect(stored.statusHistory.map((h) => h.to)).toEqual(['PENDING', 'FULFILLED']);
  });

  test('storage is outside the public client directory', () => {
    const clientDir = path.resolve(__dirname, '..', '..', 'client');
    expect(path.resolve(uploadDir()).startsWith(clientDir)).toBe(false);
    expect(path.resolve(require('../config/env').uploadDir).startsWith(clientDir)).toBe(false);
  });

  test('SECURITY: text file renamed .pdf is rejected, nothing stored, status unchanged', async () => {
    const { r, clerkAgent } = await setup();
    const res = await upload(clerkAgent, r._id, TXT, 'fake.pdf');
    expect(res.status).toBe(400);
    expect((await Request.findById(r._id)).status).toBe('APPROVED');
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: executable renamed .png is rejected', async () => {
    const { r, clerkAgent } = await setup();
    expect((await upload(clerkAgent, r._id, EXE, 'virus.png')).status).toBe(400);
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: valid PNG with a .pdf extension is rejected (extension must match content)', async () => {
    const { r, clerkAgent } = await setup();
    expect((await upload(clerkAgent, r._id, PNG, 'scan.pdf')).status).toBe(400);
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: disallowed extension (.exe/.html/.svg) is rejected even with valid content', async () => {
    const { r, clerkAgent } = await setup();
    for (const name of ['a.exe', 'a.html', 'a.svg', 'noextension']) {
      expect((await upload(clerkAgent, r._id, PDF, name)).status).toBe(400);
    }
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: oversized upload (> 5 MB) -> 413, nothing stored', async () => {
    const { r, clerkAgent } = await setup();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(clerkAgent, r._id, big, 'big.pdf');
    expect(res.status).toBe(413);
    expect((await Request.findById(r._id)).status).toBe('APPROVED');
    expect(storedFiles()).toHaveLength(0);
  });

  test('file just under the limit is accepted', async () => {
    const { r, clerkAgent } = await setup();
    const ok = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4 * 1024 * 1024)]);
    expect((await upload(clerkAgent, r._id, ok, 'ok.pdf')).status).toBe(200);
  });

  test('missing file, wrong field name and JSON body -> 400', async () => {
    const { r, clerkAgent } = await setup();
    expect((await clerkAgent.post(`/api/requests/${r._id}/document`).set(CSRF)).status).toBe(400);
    expect((await upload(clerkAgent, r._id, PDF, 'a.pdf', 'file')).status).toBe(400);
    expect((await clerkAgent.post(`/api/requests/${r._id}/document`).set(CSRF).send({ document: 'x' })).status).toBe(400);
    expect(storedFiles()).toHaveLength(0);
  });

  test.each(['PENDING', 'UNDER_REVIEW', 'REJECTED', 'FULFILLED'])('upload on a %s request -> 409, nothing stored', async (status) => {
    const { r, clerkAgent } = await setup('CSE', status);
    const res = await upload(clerkAgent, r._id, PDF);
    expect(res.status).toBe(409);
    expect((await Request.findById(r._id)).status).toBe(status);
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: student, HOD and admin cannot upload (403)', async () => {
    const { r, studentAgent, hodAgent } = await setup();
    const admin = await createUser({ role: 'ADMIN' });
    const adminAgent = await loginAgent(app, admin);
    for (const agent of [studentAgent, hodAgent, adminAgent]) {
      expect((await upload(agent, r._id, PDF)).status).toBe(403);
    }
    expect((await Request.findById(r._id)).status).toBe('APPROVED');
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: clerk of another department gets 404', async () => {
    const { r } = await setup('CSE');
    const other = await createUser({ role: 'CLERK', department: 'EEE' });
    const agent = await loginAgent(app, other);
    expect((await upload(agent, r._id, PDF)).status).toBe(404);
    expect(storedFiles()).toHaveLength(0);
  });

  test('unauthenticated -> 401, missing CSRF header -> 403, inactive clerk -> 403', async () => {
    const { r, clerk, clerkAgent } = await setup();
    expect((await request(app).post(`/api/requests/${r._id}/document`).set(CSRF).attach('document', PDF, { filename: 'a.pdf' })).status).toBe(401);
    expect((await clerkAgent.post(`/api/requests/${r._id}/document`).attach('document', PDF, { filename: 'a.pdf' })).status).toBe(403);
    await User.updateOne({ _id: clerk._id }, { isActive: false });
    expect((await upload(clerkAgent, r._id, PDF)).status).toBe(403);
    expect(storedFiles()).toHaveLength(0);
  });

  test('SECURITY: two clerks uploading at once -> one wins, loser file is cleaned up', async () => {
    const { r, clerkAgent } = await setup();
    const clerk2 = await createUser({ role: 'CLERK', department: 'CSE' });
    const clerk2Agent = await loginAgent(app, clerk2);
    const results = await Promise.all([upload(clerkAgent, r._id, PDF, 'one.pdf'), upload(clerk2Agent, r._id, PNG, 'two.png')]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    const stored = await Request.findById(r._id).select('+documentPath');
    expect(stored.status).toBe('FULFILLED');
    expect(storedFiles()).toEqual([stored.documentPath]);
  });

  test('FAILURE HANDLING: if the DB/audit step fails, request is NOT fulfilled and the file is removed', async () => {
    const { r, clerkAgent } = await setup();
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    const res = await upload(clerkAgent, r._id, PDF);
    expect(res.status).toBe(500);
    const stored = await Request.findById(r._id).select('+documentPath');
    expect(stored.status).toBe('APPROVED');
    expect(stored.documentPath).toBeNull();
    expect(storedFiles()).toHaveLength(0);
  });
});

describe('GET /api/requests/:id/document (download)', () => {
  async function fulfilled(dept = 'CSE') {
    const ctx = await setup(dept);
    expect((await upload(ctx.clerkAgent, ctx.r._id, PDF, 'official.pdf')).status).toBe(200);
    return ctx;
  }

  test('student downloads their own document: correct bytes and safe headers', async () => {
    const { r, studentAgent } = await fulfilled();
    const res = await studentAgent.get(`/api/requests/${r._id}/document`).buffer(true).parse((resp, cb) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.body.equals(PDF)).toBe(true);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Bonafide_Certificate_[0-9a-f]{24}\.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('clerk and HOD of the same department can download', async () => {
    const { r, clerkAgent, hodAgent } = await fulfilled();
    expect((await clerkAgent.get(`/api/requests/${r._id}/document`)).status).toBe(200);
    expect((await hodAgent.get(`/api/requests/${r._id}/document`)).status).toBe(200);
  });

  test("SECURITY: another student cannot download (404)", async () => {
    const { r } = await fulfilled();
    const other = await createUser({ role: 'STUDENT', department: 'CSE' });
    const agent = await loginAgent(app, other);
    expect((await agent.get(`/api/requests/${r._id}/document`)).status).toBe(404);
  });

  test('SECURITY: staff of another department cannot download (404)', async () => {
    const { r } = await fulfilled('CSE');
    for (const role of ['CLERK', 'HOD']) {
      const u = await createUser({ role, department: 'ME' });
      expect((await (await loginAgent(app, u)).get(`/api/requests/${r._id}/document`)).status).toBe(404);
    }
  });

  test('SECURITY: admin cannot read document contents (403); unauthenticated -> 401', async () => {
    const { r } = await fulfilled();
    const admin = await createUser({ role: 'ADMIN' });
    expect((await (await loginAgent(app, admin)).get(`/api/requests/${r._id}/document`)).status).toBe(403);
    expect((await request(app).get(`/api/requests/${r._id}/document`)).status).toBe(401);
  });

  test('SECURITY: deactivated student cannot download', async () => {
    const { r, student, studentAgent } = await fulfilled();
    await User.updateOne({ _id: student._id }, { isActive: false });
    expect((await studentAgent.get(`/api/requests/${r._id}/document`)).status).toBe(403);
  });

  test.each(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])('download on a %s request -> 409', async (status) => {
    const { r, studentAgent } = await setup('CSE', status);
    expect((await studentAgent.get(`/api/requests/${r._id}/document`)).status).toBe(409);
  });

  test('missing file on disk -> 404 (no crash, no path leak)', async () => {
    const { r, studentAgent } = await fulfilled();
    fs.rmSync(uploadDir(), { recursive: true, force: true });
    const res = await studentAgent.get(`/api/requests/${r._id}/document`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(uploadDir());
  });

  test('SECURITY: a tampered path in the database is never followed (no traversal)', async () => {
    const { r, studentAgent } = await fulfilled();
    for (const bad of ['../../.env', '..\\..\\.env', '/etc/passwd', 'C:\\Windows\\win.ini', 'abc.pdf']) {
      await Request.collection.updateOne({ _id: r._id }, { $set: { documentPath: bad } });
      const res = await studentAgent.get(`/api/requests/${r._id}/document`);
      expect(res.status).toBe(500);
      expect(res.text).not.toMatch(/root:|\[fonts\]|JWT_SECRET/);
    }
  });

  test('invalid id -> 400; download is audited', async () => {
    const { r, student, studentAgent } = await fulfilled();
    expect((await studentAgent.get('/api/requests/nope/document')).status).toBe(400);
    await studentAgent.get(`/api/requests/${r._id}/document`);
    const logs = await AuditLog.find({ action: 'DOCUMENT_DOWNLOADED', requestId: r._id });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(student._id));
  });
});

describe('storage naming', () => {
  test('stored names are unique across uploads', async () => {
    const names = new Set();
    for (let i = 0; i < 3; i += 1) {
      const { r, clerkAgent } = await setup();
      await upload(clerkAgent, r._id, PDF);
      names.add((await Request.findById(r._id).select('+documentPath')).documentPath);
    }
    expect(names.size).toBe(3);
    expect(crypto.randomUUID()).toBeDefined();
  });
});
