'use strict';

// S4 gate: several documents per request, replacement and revocation with history, malware
// scanning, public verification and tenant isolation, on BOTH storage adapters.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, createRequest, loginAgent, request, makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const { startFakeS3, startFakeClamd, closedPort, EICAR } = require('./fakes');
const config = require('../config/env');
const Request = require('../models/Request');
const Document = require('../models/Document');
const AuditLog = require('../models/AuditLog');
const auditService = require('../services/auditService');
const LocalAdapter = require('../storage/localAdapter');
const S3Adapter = require('../storage/s3Adapter');
const { useStorage, getStorage } = require('../storage');

let app;
let fakeS3;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000, uploadRateLimitMax: 1000 });
  fakeS3 = await startFakeS3();
});
afterAll(async () => {
  await fakeS3.close();
  await stopDb();
});
afterEach(() => jest.restoreAllMocks());

const pdf = (label = crypto.randomUUID()) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const post = (agent, url, body) => agent.post(url).set(CSRF).send(body || {});
const upload = (agent, url, buf, filename = 'letter.pdf') => agent.post(url).set(CSRF).attach('document', buf, { filename });
const download = (agent, url) =>
  agent.get(url).buffer(true).parse((resp, cb) => {
    const chunks = [];
    resp.on('data', (c) => chunks.push(c));
    resp.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const storedKeys = async () => (await getStorage().list()).map((f) => f.key).sort();
const code = (url) => new URL(url).searchParams.get('code');

async function cast(dept = 'CSE', tenant, slug) {
  const t = tenant ? { tenant } : {};
  const users = {
    student: await createUser({ role: 'STUDENT', department: dept, ...t }),
    clerk: await createUser({ role: 'CLERK', department: dept, ...t }),
    hod: await createUser({ role: 'HOD', department: dept, ...t }),
    admin: await createUser({ role: 'ADMIN', ...t }),
    principal: await createUser({ role: 'PRINCIPAL', department: null, ...t }),
  };
  const agents = {};
  for (const [k, u] of Object.entries(users)) agents[k] = await loginAgent(app, u, 'Passw0rdTest', slug);
  return { ...users, a: agents };
}
// An APPROVED request, optionally fulfilled by the clerk with one document.
async function scenario({ fulfil = true, dept = 'CSE', tenant, slug } = {}) {
  const c = await cast(dept, tenant, slug);
  const r = await createRequest(c.student, { status: 'APPROVED' }, tenant);
  const buf = pdf('first');
  let first = null;
  if (fulfil) {
    const res = await upload(c.a.clerk, `/api/requests/${r._id}/document`, buf);
    expect(res.status).toBe(200);
    first = res.body.data.document;
  }
  return { ...c, r, buf, first, id: r._id };
}

describe.each([
  ['local', async () => {
    const adapter = new LocalAdapter(process.env.UPLOAD_DIR);
    useStorage(adapter);
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
    return adapter;
  }],
  ['s3', async () => {
    const adapter = new S3Adapter(fakeS3.config);
    useStorage(adapter);
    fakeS3.objects.clear();
    return adapter;
  }],
])('documents on the %s adapter', (name, prepare) => {
  beforeEach(async () => {
    await clearDb();
    await prepare();
  });

  test('fulfilment stores the file under a tenant-prefixed key, records it, and the student downloads the exact bytes', async () => {
    const s = await scenario();
    const keys = await storedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${getDefaultTenant()._id}/${s.id}/[0-9a-f-]{36}\\.pdf$`));
    const doc = await Document.findOne({ requestId: s.id }).select('+key +sha256');
    expect(doc.key).toBe(keys[0]);
    expect(doc.sha256).toBe(sha(s.buf));
    expect(String(doc.uploadedBy)).toBe(String(s.clerk._id));
    expect(JSON.stringify(s.first)).not.toMatch(/sha256|"key"/);

    const res = await download(s.a.student, `/api/requests/${s.id}/document`);
    expect(res.status).toBe(200);
    expect(res.body.equals(s.buf)).toBe(true);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-length']).toBe(String(s.buf.length));
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('a FULFILLED request takes further documents; everyone entitled can list and download each', async () => {
    const s = await scenario();
    const second = pdf('receipt');
    const added = await upload(s.a.clerk, `/api/requests/${s.id}/documents`, second, 'receipt.pdf');
    expect(added.status).toBe(201);
    expect(added.body.data.document).toMatchObject({ version: 1, status: 'ACTIVE', fileType: 'pdf' });
    expect(await storedKeys()).toHaveLength(2);

    for (const who of ['clerk', 'hod', 'student']) {
      const list = await s.a[who].get(`/api/requests/${s.id}/documents`);
      expect([who, list.status, list.body.data.items.length]).toEqual([who, 200, 2]);
      expect(JSON.stringify(list.body)).not.toMatch(/sha256|"key"|passwordHash/);
    }
    const one = await download(s.a.student, `/api/requests/${s.id}/documents/${added.body.data.document._id}/file`);
    expect(one.status).toBe(200);
    expect(one.body.equals(second)).toBe(true);
    expect(one.headers['content-disposition']).toMatch(/_v1_[0-9a-f]{6}\.pdf/); // several documents: id suffix
    // The plain endpoint serves the newest active document.
    expect((await download(s.a.student, `/api/requests/${s.id}/document`)).body.equals(second)).toBe(true);
    const lst = await s.a.student.get('/api/requests');
    expect(lst.body.data.items[0].documentCount).toBe(2);
  });

  test('adding is only for the clerk of the request\'s department on a FULFILLED request', async () => {
    const s = await scenario();
    const approved = await createRequest(s.student, { status: 'APPROVED' });
    expect((await upload(s.a.clerk, `/api/requests/${approved._id}/documents`, pdf())).status).toBe(409); // not fulfilled yet
    const other = await createUser({ role: 'CLERK', department: 'ME' });
    expect((await upload(await loginAgent(app, other), `/api/requests/${s.id}/documents`, pdf())).status).toBe(404);
    for (const who of ['student', 'hod', 'admin', 'principal']) {
      expect([who, (await upload(s.a[who], `/api/requests/${s.id}/documents`, pdf())).status]).toEqual([who, 403]);
    }
    expect((await request(app).post(`/api/requests/${s.id}/documents`).set(CSRF).attach('document', pdf(), { filename: 'a.pdf' })).status).toBe(401);
    expect((await upload(s.a.clerk, `/api/requests/${s.id}/documents`, Buffer.from('not a pdf at all'))).status).toBe(400);
    expect(await storedKeys()).toHaveLength(1);
  });

  test('replacing creates version 2: the old one is kept as history but can no longer be downloaded', async () => {
    const s = await scenario();
    const v2 = pdf('corrected');
    const res = await upload(s.a.clerk, `/api/requests/${s.id}/documents/${s.first._id}/replace`, v2, 'v2.pdf');
    expect(res.status).toBe(200);
    expect(res.body.data.document).toMatchObject({ version: 2, status: 'ACTIVE', supersedes: s.first._id });
    const old = await Document.findById(s.first._id);
    expect(old.status).toBe('REPLACED');
    expect(old.replacedAt).toBeTruthy();
    expect(await storedKeys()).toHaveLength(2); // the old file stays until the retention period passes

    expect((await download(s.a.student, `/api/requests/${s.id}/documents/${s.first._id}/file`)).status).toBe(404);
    expect((await download(s.a.student, `/api/requests/${s.id}/document`)).body.equals(v2)).toBe(true);
    const clerkList = (await s.a.clerk.get(`/api/requests/${s.id}/documents`)).body.data.items;
    expect(clerkList.map((d) => `${d.version}:${d.status}`)).toEqual(['1:REPLACED', '2:ACTIVE']);
    const studentList = (await s.a.student.get(`/api/requests/${s.id}/documents`)).body.data.items;
    expect(studentList.map((d) => `${d.version}:${d.status}`)).toEqual(['2:ACTIVE']);
    expect((await upload(s.a.clerk, `/api/requests/${s.id}/documents/${s.first._id}/replace`, pdf(), 'x.pdf')).status).toBe(409); // already replaced
    expect((await AuditLog.findOne({ action: 'DOCUMENT_REPLACED' })).details).toMatchObject({ version: 2, replaces: String(s.first._id) });
    for (const who of ['student', 'hod', 'admin']) {
      expect((await upload(s.a[who], `/api/requests/${s.id}/documents/${res.body.data.document._id}/replace`, pdf())).status).toBe(403);
    }
    expect((await upload(s.a.clerk, `/api/requests/${s.id}/documents/64b64b64b64b64b64b64b640/replace`, pdf())).status).toBe(404);
  });

  test('revoking withdraws a document: reason kept for staff, hidden from the student, never in the audit trail', async () => {
    const s = await scenario();
    const extra = (await upload(s.a.clerk, `/api/requests/${s.id}/documents`, pdf('extra'))).body.data.document;
    expect((await s.a.clerk.delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({ reason: 'x' })).status).toBe(400);
    expect((await s.a.clerk.delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({})).status).toBe(400);
    for (const who of ['student', 'hod', 'admin']) {
      expect((await s.a[who].delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({ reason: 'not allowed to' })).status).toBe(403);
    }
    const res = await s.a.clerk.delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({ reason: 'Issued with the wrong name' });
    expect(res.status).toBe(200);
    expect(res.body.data.document.status).toBe('REVOKED');

    expect((await download(s.a.student, `/api/requests/${s.id}/documents/${s.first._id}/file`)).status).toBe(404);
    expect((await s.a.clerk.delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({ reason: 'again please' })).status).toBe(409);
    const staff = (await s.a.hod.get(`/api/requests/${s.id}/documents`)).body.data.items;
    expect(staff.find((d) => d._id === s.first._id)).toMatchObject({ status: 'REVOKED', revokedReason: 'Issued with the wrong name' });
    const mine = await s.a.student.get(`/api/requests/${s.id}/documents`);
    expect(mine.body.data.items.map((d) => d._id)).toEqual([extra._id]);
    expect(JSON.stringify(mine.body)).not.toContain('wrong name');
    expect(JSON.stringify(await AuditLog.find({}).lean())).not.toContain('wrong name');
    expect(await AuditLog.countDocuments({ action: 'DOCUMENT_REVOKED' })).toBe(1);

    // Revoke the last one: the request stays FULFILLED but has nothing to download.
    await s.a.clerk.delete(`/api/requests/${s.id}/documents/${extra._id}`).set(CSRF).send({ reason: 'Withdrawn entirely' });
    expect((await Request.findById(s.id)).status).toBe('FULFILLED');
    expect((await download(s.a.student, `/api/requests/${s.id}/document`)).status).toBe(409);
    expect((await s.a.student.get('/api/requests')).body.data.items[0].documentCount).toBe(0);
  });

  test('two clerks replacing the same document at once: exactly one wins and the loser\'s file is cleaned up', async () => {
    const s = await scenario();
    const clerk2 = await createUser({ role: 'CLERK', department: 'CSE' });
    const agent2 = await loginAgent(app, clerk2);
    const results = await Promise.all([
      upload(s.a.clerk, `/api/requests/${s.id}/documents/${s.first._id}/replace`, pdf('one')),
      upload(agent2, `/api/requests/${s.id}/documents/${s.first._id}/replace`, pdf('two')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await Document.countDocuments({ requestId: s.id, status: 'ACTIVE' })).toBe(1);
    expect(await Document.countDocuments({ requestId: s.id })).toBe(2);
    expect(await storedKeys()).toHaveLength(2); // the original + the winner; the loser's file is gone
  });

  test('FAILURE HANDLING: when the database step fails nothing is half-done and the new file is removed', async () => {
    const s = await scenario();
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await upload(s.a.clerk, `/api/requests/${s.id}/documents/${s.first._id}/replace`, pdf())).status).toBe(500);
    expect((await Document.findById(s.first._id)).status).toBe('ACTIVE');
    expect(await Document.countDocuments({ requestId: s.id })).toBe(1);
    expect(await storedKeys()).toHaveLength(1);

    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await upload(s.a.clerk, `/api/requests/${s.id}/documents`, pdf())).status).toBe(500);
    expect(await Document.countDocuments({ requestId: s.id })).toBe(1);
    expect(await storedKeys()).toHaveLength(1);

    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('simulated audit failure'));
    expect((await s.a.clerk.delete(`/api/requests/${s.id}/documents/${s.first._id}`).set(CSRF).send({ reason: 'Should not stick' })).status).toBe(500);
    expect((await Document.findById(s.first._id)).status).toBe('ACTIVE');
  });

  test('a request holds at most ten active documents', async () => {
    const s = await scenario();
    const tenantId = getDefaultTenant()._id;
    for (let i = 0; i < 9; i += 1) {
      await Document.create({ requestId: s.id, key: `${tenantId}/${s.id}/${crypto.randomUUID()}.pdf`, fileType: 'pdf', sizeBytes: 10, sha256: sha(Buffer.from(String(i))), uploadedBy: s.clerk._id });
    }
    expect(await Document.countDocuments({ requestId: s.id, status: 'ACTIVE' })).toBe(10);
    const res = await upload(s.a.clerk, `/api/requests/${s.id}/documents`, pdf());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/at most 10/);
    expect(await storedKeys()).toHaveLength(1);
  });

  test('a missing stored file is a clean 404, and a tampered key is never followed', async () => {
    const s = await scenario();
    const key = (await Document.findOne({ requestId: s.id }).select('+key')).key;
    await getStorage().delete(key);
    const gone = await s.a.student.get(`/api/requests/${s.id}/document`);
    expect(gone.status).toBe(404);
    expect(gone.body.message).toBe('Document file is missing');

    const other = `${new mongoose.Types.ObjectId()}/${s.id}/${crypto.randomUUID()}.pdf`; // another tenant's prefix
    for (const bad of ['../../.env', '/etc/passwd', 'abc.pdf', other]) {
      await Document.collection.updateOne({ requestId: new mongoose.Types.ObjectId(String(s.id)) }, { $set: { key: bad } });
      const res = await s.a.student.get(`/api/requests/${s.id}/document`);
      expect([bad, res.status]).toEqual([bad, 500]);
      expect(res.text).not.toMatch(/root:|JWT_SECRET/);
    }
  });

  test('a store outage during upload is a 502 and leaves the request untouched', async () => {
    if (name !== 's3') return;
    const c = await cast();
    const r = await createRequest(c.student, { status: 'APPROVED' });
    fakeS3.state.failNext = 1;
    const res = await upload(c.a.clerk, `/api/requests/${r._id}/document`, pdf());
    expect(res.status).toBe(502);
    expect(res.body.message).not.toMatch(/secret-detail|InternalError/);
    expect((await Request.findById(r._id)).status).toBe('APPROVED');
    expect(await Document.countDocuments({})).toBe(0);
  });

  describe('malware scanning', () => {
    const saved = { ...config.clamd };
    let clam;
    afterEach(async () => {
      config.scanMode = 'off';
      Object.assign(config.clamd, saved);
      if (clam) await clam.close();
      clam = null;
    });
    const infected = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR), Buffer.from('\n%%EOF\n')]);
    async function useScanner(mode, scannerMode = 'normal', timeoutMs = 3000) {
      clam = await startFakeClamd({ mode: scannerMode });
      Object.assign(config.clamd, { host: '127.0.0.1', port: clam.port, timeoutMs });
      config.scanMode = mode;
    }

    test('an infected file is rejected (422) on every upload path: nothing stored, nothing recorded, the attempt audited', async () => {
      await useScanner('required');
      const c = await cast();
      const r = await createRequest(c.student, { status: 'APPROVED' });
      const res = await upload(c.a.clerk, `/api/requests/${r._id}/document`, infected(), 'virus.pdf');
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/virus scan/);
      expect((await Request.findById(r._id)).status).toBe('APPROVED');
      expect(await Document.countDocuments({})).toBe(0);
      expect(await storedKeys()).toHaveLength(0);
      const log = await AuditLog.findOne({ action: 'DOCUMENT_REJECTED_INFECTED' });
      expect(log.details).toMatchObject({ signature: 'Eicar-Test-Signature' });
      expect(String(log.actorId)).toBe(String(c.clerk._id));

      // And for additional documents and replacements.
      const ok = await upload(c.a.clerk, `/api/requests/${r._id}/document`, pdf('clean'));
      expect(ok.status).toBe(200);
      expect((await upload(c.a.clerk, `/api/requests/${r._id}/documents`, infected(), 'v.pdf')).status).toBe(422);
      expect((await upload(c.a.clerk, `/api/requests/${r._id}/documents/${ok.body.data.document._id}/replace`, infected(), 'v.pdf')).status).toBe(422);
      expect(await Document.countDocuments({})).toBe(1);
      expect(await storedKeys()).toHaveLength(1);
      expect((await Document.findById(ok.body.data.document._id)).status).toBe('ACTIVE');
    });

    test('a clean file is sent to the scanner byte for byte and accepted', async () => {
      await useScanner('required');
      const s = await scenario();
      expect(clam.state.scans).toBe(1);
      expect(clam.state.received[0].equals(s.buf)).toBe(true);
    });

    test('required fails closed when the scanner is down, hangs or misbehaves; optional lets the file through', async () => {
      const c = await cast();
      const r = await createRequest(c.student, { status: 'APPROVED' });
      for (const scannerMode of ['hang', 'error', 'garbage']) {
        await useScanner('required', scannerMode, 400);
        const res = await upload(c.a.clerk, `/api/requests/${r._id}/document`, pdf());
        expect([scannerMode, res.status]).toEqual([scannerMode, 503]);
        expect(await Document.countDocuments({})).toBe(0);
        expect(await storedKeys()).toHaveLength(0);
        await clam.close();
        clam = null;
      }
      Object.assign(config.clamd, { host: '127.0.0.1', port: await closedPort(), timeoutMs: 400 });
      config.scanMode = 'required';
      expect((await upload(c.a.clerk, `/api/requests/${r._id}/document`, pdf())).status).toBe(503);
      expect((await Request.findById(r._id)).status).toBe('APPROVED');
      config.scanMode = 'optional';
      expect((await upload(c.a.clerk, `/api/requests/${r._id}/document`, pdf())).status).toBe(200);
    });

    test('files are validated and requests checked BEFORE scanning, so refused uploads never reach the scanner', async () => {
      await useScanner('required');
      const c = await cast();
      const pending = await createRequest(c.student, { status: 'PENDING' });
      const approved = await createRequest(c.student, { status: 'APPROVED' });
      await upload(c.a.clerk, `/api/requests/${approved._id}/document`, Buffer.from('plain text pretending'), 'a.pdf'); // 400
      await upload(c.a.clerk, `/api/requests/${pending._id}/document`, pdf()); // 409
      await upload(c.a.student, `/api/requests/${approved._id}/document`, pdf()); // 403
      await upload(c.a.clerk, '/api/requests/64b64b64b64b64b64b64b640/document', pdf()); // 404
      expect(clam.state.scans).toBe(0);
    });
  });
});

describe('public verification and the QR link (local adapter)', () => {
  beforeEach(async () => {
    await clearDb();
    useStorage(new LocalAdapter(process.env.UPLOAD_DIR));
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  });
  const verify = (code, slug) => request(app, slug).get(`/api/verify/${code}`);
  const codeOf = async (s, docId) => code((await s.a.student.get(`/api/requests/${s.id}/documents`)).body.data.items.find((d) => d._id === docId).verifyUrl);

  test('the listing carries a verify link for active documents; verifying reveals only type, issue date and status', async () => {
    const s = await scenario();
    const items = (await s.a.clerk.get(`/api/requests/${s.id}/documents`)).body.data.items;
    expect(items[0].verifyUrl).toMatch(new RegExp(`^http://localhost:\\d+/t/default/verify\\.html\\?code=${s.first._id}-[A-Za-z0-9_-]{32}$`));
    const res = await verify(code(items[0].verifyUrl));
    expect(res.status).toBe(200); // public: no cookie needed
    expect(res.body.data).toMatchObject({ institution: 'Default Institution', status: 'VALID', valid: true, documentType: 'Bonafide Certificate', version: 1 });
    expect(Object.keys(res.body.data).sort()).toEqual(['documentType', 'institution', 'issuedAt', 'status', 'valid', 'version']);
    const dump = JSON.stringify(res.body);
    expect(dump).not.toMatch(new RegExp(`${s.student.email}|${s.student.name}|${s.clerk.email}|sha256|CSE|${s.id}`));
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the code follows the document: replaced is SUPERSEDED, revoked is REVOKED, neither is valid', async () => {
    const s = await scenario();
    const oldCode = await codeOf(s, s.first._id);
    expect((await verify(oldCode)).body.data.valid).toBe(true);
    const v2 = (await upload(s.a.clerk, `/api/requests/${s.id}/documents/${s.first._id}/replace`, pdf('v2'))).body.data.document;
    expect((await verify(oldCode)).body.data).toMatchObject({ status: 'SUPERSEDED', valid: false });
    const newCode = await codeOf(s, v2._id);
    expect((await verify(newCode)).body.data).toMatchObject({ status: 'VALID', valid: true, version: 2 });
    await s.a.clerk.delete(`/api/requests/${s.id}/documents/${v2._id}`).set(CSRF).send({ reason: 'Withdrawn by the office' });
    expect((await verify(newCode)).body.data).toMatchObject({ status: 'REVOKED', valid: false });
  });

  test('forged, truncated, wrong-document and tampered codes all answer the same 404', async () => {
    const s = await scenario();
    const second = (await upload(s.a.clerk, `/api/requests/${s.id}/documents`, pdf('two'))).body.data.document;
    const good = await codeOf(s, s.first._id);
    const [id, sig] = good.split('-');
    const otherSig = (await codeOf(s, second._id)).split('-')[1];
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const messages = new Set();
    for (const bad of [`${id}-${otherSig}`, `${id}-${flipped}`, `${id}-${'A'.repeat(32)}`, `${new mongoose.Types.ObjectId()}-${sig}`, id, `${id}-short`, 'x'.repeat(57), `${id.toUpperCase()}-${sig}`]) {
      const res = await verify(bad);
      expect([bad.slice(0, 12), res.status]).toEqual([bad.slice(0, 12), 404]);
      messages.add(res.body.message);
    }
    expect([...messages]).toEqual(['No document matches this code']);

    // The signature covers the stored hash: altering the database no longer verifies.
    await Document.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(s.first._id)) }, { $set: { sha256: sha(Buffer.from('forged')) } });
    expect((await verify(good)).status).toBe(404);
  });

  test('checking a file: the browser sends only a hash and learns only yes or no', async () => {
    const s = await scenario();
    const c = await codeOf(s, s.first._id);
    const yes = await post(request.agent(app), `/api/verify/${c}/check`, { sha256: sha(s.buf) });
    expect(yes.status).toBe(200);
    expect(yes.body.data).toEqual({ institution: 'Default Institution', matches: true, status: 'VALID', valid: true });
    const upper = await post(request.agent(app), `/api/verify/${c}/check`, { sha256: sha(s.buf).toUpperCase() });
    expect(upper.body.data.matches).toBe(true);
    const no = await post(request.agent(app), `/api/verify/${c}/check`, { sha256: sha(pdf('a different file')) });
    expect(no.body.data.matches).toBe(false);
    expect(JSON.stringify(no.body)).not.toContain(sha(s.buf));
    expect((await post(request.agent(app), `/api/verify/${c}/check`, { sha256: 'xyz' })).status).toBe(400);
    expect((await post(request.agent(app), `/api/verify/${c}/check`, {})).status).toBe(400);
    expect((await request(app).post(`/api/verify/${c}/check`).send({ sha256: sha(s.buf) })).status).toBe(403); // CSRF header still required
  });

  test('without a signing key nothing is issued and verification answers 503', async () => {
    const s = await scenario();
    const c = await codeOf(s, s.first._id);
    const key = config.verifyKey;
    config.verifyKey = '';
    try {
      expect((await s.a.clerk.get(`/api/requests/${s.id}/documents`)).body.data.items[0].verifyUrl).toBeUndefined();
      expect((await verify(c)).status).toBe(503);
    } finally {
      config.verifyKey = key;
    }
    expect((await verify(c)).status).toBe(200);
  });

  test('the public endpoint is rate limited', async () => {
    const fresh = makeApp({ authRateLimitMax: 1000 }); // its own limiter, so the other tests are unaffected
    let last;
    for (let i = 0; i < 62; i += 1) last = await request(fresh).get(`/api/verify/${new mongoose.Types.ObjectId()}-${'A'.repeat(32)}`);
    expect(last.status).toBe(429);
  });
});

describe('tenant isolation of documents (local adapter)', () => {
  beforeEach(async () => {
    await clearDb();
    useStorage(new LocalAdapter(process.env.UPLOAD_DIR));
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  });

  test('institution A can never list, download, add, replace, revoke or verify institution B\'s documents', async () => {
    const B = await makeTenant('beta-college');
    const a = await scenario();
    const b = await scenario({ tenant: B, slug: 'beta-college' });
    const bDoc2 = (await upload(b.a.clerk, `/api/requests/${b.id}/documents`, pdf('b2'))).body.data.document;

    // Stored keys are prefixed by their own institution.
    const keys = await storedKeys();
    expect(keys.filter((k) => k.startsWith(`${getDefaultTenant()._id}/`))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith(`${B._id}/`))).toHaveLength(2);

    const bId = b.id;
    for (const who of ['clerk', 'hod', 'student']) {
      expect([who, (await a.a[who].get(`/api/requests/${bId}/documents`)).status]).toEqual([who, 404]);
      expect([who, (await a.a[who].get(`/api/requests/${bId}/document`)).status]).toEqual([who, 404]);
      expect([who, (await a.a[who].get(`/api/requests/${bId}/documents/${b.first._id}/file`)).status]).toEqual([who, 404]);
    }
    expect((await upload(a.a.clerk, `/api/requests/${bId}/documents`, pdf('x'))).status).toBe(404);
    expect((await upload(a.a.clerk, `/api/requests/${bId}/document`, pdf('x'))).status).toBe(404);
    expect((await upload(a.a.clerk, `/api/requests/${bId}/documents/${b.first._id}/replace`, pdf('x'))).status).toBe(404);
    expect((await a.a.clerk.delete(`/api/requests/${bId}/documents/${b.first._id}`).set(CSRF).send({ reason: 'Not my institution' })).status).toBe(404);
    // Even with A's own request id but B's document id.
    expect((await download(a.a.student, `/api/requests/${a.id}/documents/${b.first._id}/file`)).status).toBe(404);
    expect((await a.a.clerk.delete(`/api/requests/${a.id}/documents/${bDoc2._id}`).set(CSRF).send({ reason: 'Crossing over' })).status).toBe(404);
    expect(await Document.countDocuments({ requestId: bId, status: 'ACTIVE' })).toBe(0); // (queried as default tenant: invisible)
    expect(await runAsTenant(B._id, () => Document.countDocuments({ requestId: bId, status: 'ACTIVE' }))).toBe(2);
    expect(await storedKeys()).toHaveLength(3);

    // Verification codes only work under their own institution's address.
    const bCode = code((await b.a.student.get(`/api/requests/${bId}/documents`)).body.data.items[0].verifyUrl);
    expect((await request(app, 'beta-college').get(`/api/verify/${bCode}`)).status).toBe(200);
    expect((await request(app).get(`/api/verify/${bCode}`)).status).toBe(404);
    expect((await post(request.agent(app), `/api/verify/${bCode}/check`, { sha256: sha(b.buf) })).status).toBe(404);
  });

  test('a session from one institution is refused on every document route of another', async () => {
    const B = await makeTenant('beta-college');
    const a = await scenario();
    const b = await scenario({ tenant: B, slug: 'beta-college' });
    const { forgeToken } = require('./helpers');
    const token = forgeToken(a.clerk._id);
    const probes = [
      ['get', `/api/requests/${b.id}/documents`], ['get', `/api/requests/${b.id}/document`],
      ['get', `/api/requests/${b.id}/documents/${b.first._id}/file`], ['post', `/api/requests/${b.id}/documents`],
      ['post', `/api/requests/${b.id}/document`], ['post', `/api/requests/${b.id}/documents/${b.first._id}/replace`],
      ['delete', `/api/requests/${b.id}/documents/${b.first._id}`],
    ];
    for (const [method, url] of probes) {
      const res = await request(app, 'beta-college')[method](url).set(CSRF).set('Cookie', `${config.cookieName}=${token}`).send({});
      expect([method, url, res.status]).toEqual([method, url, 401]);
    }
    expect(await runAsTenant(B._id, () => Document.countDocuments({ status: 'ACTIVE' }))).toBe(1);
    void runUnscoped;
  });
});
