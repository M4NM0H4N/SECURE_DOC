'use strict';

// S7: the audit log is a per-institution hash chain. Changing, removing, inserting or reordering
// entries is detectable; this is tamper-EVIDENT, not tamper-proof (the last test says why).
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const crypto = require('crypto');
const {
  startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, forgeToken, request, makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const config = require('../config/env');
const audit = require('../services/auditService');
const AuditLog = require('../models/AuditLog');
const AuditChain = require('../models/AuditChain');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);
afterEach(() => jest.restoreAllMocks());

const entries = (tenantId) => AuditLog.collection.find({ tenantId, seq: { $ne: null } }).sort({ seq: 1 }).toArray();
const tid = () => getDefaultTenant()._id;
const verify = () => audit.verifyChain();
const actor = () => new mongoose.Types.ObjectId();

// n audit entries through the real service, one after another.
async function make(n, details = (i) => ({ i })) {
  const a = actor();
  for (let i = 0; i < n; i += 1) await audit.record({ actorId: a, action: 'USER_LOGIN', details: details(i) });
  return a;
}

describe('building the chain', () => {
  test('entries get consecutive numbers, each carries the hash of the one before, and the whole chain verifies', async () => {
    await make(6);
    const list = await entries(tid());
    expect(list.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(list[0].prevHash).toBe('GENESIS');
    for (let i = 1; i < list.length; i += 1) expect(list[i].prevHash).toBe(list[i - 1].hash);
    expect(list.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
    expect(new Set(list.map((e) => e.hash)).size).toBe(6);
    const v = await verify();
    expect(v).toMatchObject({ ok: true, checked: 6, unchained: 0, headSeq: 6, headHash: list[5].hash, broken: null });
  });

  test('(unit) the hash is deterministic, ignores key order in details, and changes with any field', () => {
    const base = { tenantId: new mongoose.Types.ObjectId(), seq: 3, actorId: actor(), action: 'USER_LOGIN', requestId: null, details: { a: 1, b: { c: 2, d: [1, 2] } }, timestamp: new Date('2026-01-01T00:00:00Z'), prevHash: 'x'.repeat(64) };
    const h = audit.entryHash(base);
    expect(audit.entryHash({ ...base })).toBe(h);
    expect(audit.entryHash({ ...base, details: { b: { d: [1, 2], c: 2 }, a: 1 } })).toBe(h);
    for (const change of [{ seq: 4 }, { action: 'USER_ACTIVATED' }, { details: { a: 2 } }, { prevHash: 'y'.repeat(64) }, { timestamp: new Date('2026-01-01T00:00:00.001Z') }, { requestId: new mongoose.Types.ObjectId() }, { actorId: actor() }, { tenantId: null }]) {
      expect(audit.entryHash({ ...base, ...change })).not.toBe(h);
    }
  });

  test('secrets never reach the chain (the existing sanitising still applies)', async () => {
    await audit.record({ actorId: actor(), action: 'USER_LOGIN', details: { password: 'hunter2', token: 'abc', safe: 'ok', nested: { secret: 's' } } });
    const [e] = await entries(tid());
    expect(e.details).toEqual({ safe: 'ok' }); // the emptied nested object is dropped before hashing and storing
    expect((await verify()).ok).toBe(true);
  });

  test('many writers at once still produce one unbroken chain', async () => {
    const a = actor();
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit.record({ actorId: a, action: 'USER_LOGIN', details: { i } })));
    const list = await entries(tid());
    expect(list.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await verify()).toMatchObject({ ok: true, checked: 25 });
  });

  test('real traffic (sign-ins, invitations, exports) chains correctly under concurrency', async () => {
    const users = await Promise.all([1, 2, 3, 4, 5, 6].map(() => createUser({ role: 'STUDENT' })));
    await Promise.all(users.map((u) => loginAgent(app, u)));
    const admin = await createUser({ role: 'ADMIN' });
    const agent = await loginAgent(app, admin);
    await Promise.all([1, 2, 3].map((i) => agent.post('/api/admin/invites').set(CSRF).send({ email: `s${i}@example.com`, role: 'CLERK', department: 'CSE' })));
    const v = (await agent.get('/api/admin/audit-logs/verify')).body.data;
    expect(v).toMatchObject({ ok: true, unchained: 0 });
    expect(v.checked).toBeGreaterThanOrEqual(10);
    expect(v.headSeq).toBe(v.checked);
  });

  test('a write that rolls back leaves no gap: the head moves only with the entry', async () => {
    await make(3);
    jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('simulated failure after the head moved'));
    await expect(audit.record({ actorId: actor(), action: 'USER_LOGIN' })).rejects.toThrow(/simulated/);
    expect(await verify()).toMatchObject({ ok: true, checked: 3, headSeq: 3 });
    await audit.record({ actorId: actor(), action: 'USER_LOGIN' });
    expect((await entries(tid())).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await verify()).ok).toBe(true);
  });
});

describe('detecting tampering', () => {
  const col = AuditLog.collection;

  test('changing an entry is caught at that entry', async () => {
    await make(8);
    const target = (await entries(tid()))[4];
    await col.updateOne({ _id: target._id }, { $set: { 'details.i': 999 } });
    expect((await verify())).toMatchObject({ ok: false, broken: { seq: 5, reason: 'the entry was altered' } });
    await col.updateOne({ _id: target._id }, { $set: { 'details.i': 4 } });
    expect((await verify()).ok).toBe(true); // restoring the exact value heals it, which proves the check is about content
    await col.updateOne({ _id: target._id }, { $set: { action: 'USER_ACTIVATED' } });
    expect((await verify()).broken.seq).toBe(5);
  });

  test('removing an entry from the middle, the end, or everything is caught', async () => {
    await make(8);
    const list = await entries(tid());
    await col.deleteOne({ _id: list[3]._id });
    expect(await verify()).toMatchObject({ ok: false, broken: { seq: 4, reason: 'an entry is missing' } });
    await col.insertOne(list[3]); // put it back
    expect((await verify()).ok).toBe(true);

    await col.deleteOne({ _id: list[7]._id });
    expect(await verify()).toMatchObject({ ok: false, broken: { seq: 8, reason: 'the newest entries are missing' } });
    await col.deleteMany({ tenantId: tid() });
    expect((await verify())).toMatchObject({ ok: false, checked: 0 });
  });

  test('entries with empty or missing details verify (the database drops them when storing)', async () => {
    const a = actor();
    await audit.record({ actorId: a, action: 'USER_LOGIN' });
    await audit.record({ actorId: a, action: 'USER_LOGIN', details: {} });
    await audit.record({ actorId: a, action: 'USER_LOGIN', details: { x: undefined, y: { z: {} }, list: [undefined, 1] } });
    expect(await verify()).toMatchObject({ ok: true, checked: 3 });
  });

  test('a forged entry added at the end, or squeezed in, is caught', async () => {
    await make(5);
    const list = await entries(tid());
    // Appended without moving the head.
    const forged = { ...list[4], _id: new mongoose.Types.ObjectId(), seq: 6, prevHash: list[4].hash };
    forged.hash = audit.entryHash({ ...forged });
    await col.insertOne(forged);
    expect((await verify())).toMatchObject({ ok: false, broken: { reason: 'the chain head does not match the entries' } });
    await col.deleteOne({ _id: forged._id });
    // A duplicate sequence number.
    await col.insertOne({ ...list[2], _id: new mongoose.Types.ObjectId() }).catch(() => {}); // refused by the unique index
    expect((await verify()).ok).toBe(true);
  });

  test('rewriting one entry consistently still breaks the link to the next one', async () => {
    await make(6);
    const list = await entries(tid());
    const evil = { ...list[2], details: { i: 'forged' } };
    evil.hash = audit.entryHash({ ...evil });
    await col.updateOne({ _id: list[2]._id }, { $set: { details: evil.details, hash: evil.hash } });
    expect(await verify()).toMatchObject({ ok: false, broken: { seq: 4, reason: 'link to the previous entry does not match' } });
  });

  test('swapping two entries is caught', async () => {
    await make(6);
    const list = await entries(tid());
    // Swap sequence numbers 2 and 3 (through a free number, because the unique index forbids duplicates).
    await col.updateOne({ _id: list[1]._id }, { $set: { seq: 99 } });
    await col.updateOne({ _id: list[2]._id }, { $set: { seq: 2 } });
    await col.updateOne({ _id: list[1]._id }, { $set: { seq: 3 } });
    const v = await verify();
    expect(v.ok).toBe(false);
    expect(v.broken.seq).toBe(2);
  });

  test('LIMIT: someone who rewrites every entry AND the head produces a chain that verifies, so keep the head hash elsewhere', async () => {
    await make(5);
    const honestHead = (await verify()).headHash;
    const list = await entries(tid());
    let prev = 'GENESIS';
    for (const e of list) {
      const details = { i: 'rewritten' };
      const hash = audit.entryHash({ ...e, details, prevHash: prev });
      await col.updateOne({ _id: e._id }, { $set: { details, prevHash: prev, hash } });
      prev = hash;
    }
    await AuditChain.collection.updateOne({ tenantId: tid() }, { $set: { lastHash: prev } });
    const after = await verify();
    expect(after.ok).toBe(true); // a full rewrite by someone with database access is not detectable from inside the database
    expect(after.headHash).not.toBe(honestHead); // ...but it IS detectable against a head hash you saved earlier
  });
});

describe('each institution has its own chain', () => {
  test('chains are independent, a break in one does not affect the other, and counts never mix', async () => {
    const B = await makeTenant('beta-college');
    const a1 = actor();
    for (let i = 0; i < 4; i += 1) await audit.record({ actorId: a1, action: 'USER_LOGIN', details: { i } });
    await runAsTenant(B._id, async () => {
      for (let i = 0; i < 3; i += 1) await audit.record({ actorId: a1, action: 'USER_LOGIN', details: { i } });
    });
    expect((await entries(tid())).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await entries(B._id)).map((e) => e.seq)).toEqual([1, 2, 3]); // B starts at 1 too

    expect(await verify()).toMatchObject({ ok: true, checked: 4 });
    expect(await runAsTenant(B._id, () => verify())).toMatchObject({ ok: true, checked: 3 });

    const bFirst = (await entries(B._id))[1];
    await AuditLog.collection.updateOne({ _id: bFirst._id }, { $set: { 'details.i': 'tampered' } });
    expect((await verify()).ok).toBe(true); // A unaffected
    expect((await runAsTenant(B._id, () => verify()))).toMatchObject({ ok: false, broken: { seq: 2 } });
  });

  test('platform events (no institution) have their own chain, invisible to institutions', async () => {
    await runUnscoped(() => audit.record({ actorId: actor(), action: 'PLATFORM_LOGIN' }));
    await runUnscoped(() => audit.record({ actorId: actor(), action: 'PLATFORM_LOGIN' }));
    const platform = await AuditLog.collection.find({ tenantId: null, seq: { $ne: null } }).sort({ seq: 1 }).toArray();
    expect(platform.map((e) => e.seq)).toEqual([1, 2]);
    expect(await verify()).toMatchObject({ ok: true, checked: 0, headSeq: 0 }); // an institution sees none of it
  });

  test('the verify endpoint is for the Admin only, reports counts without content, and never crosses institutions', async () => {
    const B = await makeTenant('beta-college');
    const admin = await createUser({ role: 'ADMIN' });
    const adminB = await createUser({ role: 'ADMIN', tenant: B });
    const clerk = await createUser({ role: 'CLERK' });
    const a = await loginAgent(app, admin);
    const b = await loginAgent(app, adminB, 'Passw0rdTest', 'beta-college');
    for (let i = 0; i < 3; i += 1) await loginAgent(app, clerk);

    const res = await a.get('/api/admin/audit-logs/verify');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(Object.keys(res.body.data).sort()).toEqual(['broken', 'checked', 'headHash', 'headSeq', 'ok', 'unchained']);
    const bRes = await b.get('/api/admin/audit-logs/verify');
    expect(bRes.body.data.checked).toBeLessThan(res.body.data.checked);

    const c = await loginAgent(app, clerk);
    expect((await c.get('/api/admin/audit-logs/verify')).status).toBe(403);
    expect((await request(app).get('/api/admin/audit-logs/verify')).status).toBe(401);
    const token = forgeToken(admin._id);
    expect((await request(app, 'beta-college').get('/api/admin/audit-logs/verify').set('Cookie', `${config.cookieName}=${token}`)).status).toBe(401);

    // Tampering shows up through the endpoint too.
    const mid = (await entries(tid()))[1];
    await AuditLog.collection.updateOne({ _id: mid._id }, { $set: { action: 'USER_ACTIVATED' } });
    const broken = (await a.get('/api/admin/audit-logs/verify')).body.data;
    expect(broken).toMatchObject({ ok: false, broken: { seq: 2, reason: 'the entry was altered' } });
  });
});

describe('entries from before the chain existed', () => {
  test('they are reported as unchained, then sealed oldest-first by the backfill, and new entries continue after them', async () => {
    const a = actor();
    const t = tid();
    const old = (i) => ({ _id: new mongoose.Types.ObjectId(), tenantId: t, actorId: a, action: 'USER_LOGIN', requestId: null, details: { legacy: i }, timestamp: new Date(2025, 0, 1 + i) });
    // Inserted newest-first on purpose: the backfill must order by time, not insertion.
    await AuditLog.collection.insertMany([old(2), old(0), old(1)]);
    expect(await verify()).toMatchObject({ ok: true, checked: 0, unchained: 3 });

    expect(await audit.backfillChain()).toBe(3);
    const sealed = await entries(t);
    expect(sealed.map((e) => e.details.legacy)).toEqual([0, 1, 2]);
    expect(sealed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await verify()).toMatchObject({ ok: true, checked: 3, unchained: 0, headSeq: 3 });
    expect(await audit.backfillChain()).toBe(0); // idempotent

    await audit.record({ actorId: a, action: 'USER_LOGIN', details: { fresh: true } });
    expect((await entries(t)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await verify()).ok).toBe(true);
    void crypto;
  });
});
