'use strict';

// S7: search, filters, sorting and pagination on every list, CSV export, and large lists.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const {
  startDb, stopDb, clearDb, makeApp, createUser, createRequest, loginAgent, request, makeTenant, getDefaultTenant, runAsTenant, runUnscoped,
} = require('./helpers');
const { toCsv, cell } = require('../utils/csv');
const { escapeRegex, contains, sortSpec, dateRange } = require('../utils/listQuery');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const WorkflowDefinition = require('../models/WorkflowDefinition');

let app;
beforeAll(async () => {
  await startDb();
  app = makeApp({ authRateLimitMax: 1000 });
});
afterAll(stopDb);
beforeEach(clearDb);

const ids = (res) => res.body.data.items.map((i) => i._id);

describe('building blocks (unit)', () => {
  test('(unit) search text is escaped, so it can never act as a regular expression', () => {
    expect(escapeRegex('a.b*c(d)[e]')).toBe('a\\.b\\*c\\(d\\)\\[e\\]');
    const rx = contains('(a+)+$');
    expect(rx.test('xx(a+)+$yy')).toBe(true);
    expect(rx.test('aaaa')).toBe(false);
    expect(contains('x'.repeat(500)).source.length).toBeLessThan(100);
    expect(contains('  Trans  ').test('transcript')).toBe(true);
  });

  test('(unit) sorting always has a stable tie-break and defaults to newest first', () => {
    expect(sortSpec({ defaultSort: 'createdAt' })).toEqual({ createdAt: -1, _id: -1 });
    expect(sortSpec({ sort: 'name', order: 'asc', defaultSort: 'createdAt' })).toEqual({ name: 1, _id: 1 });
  });

  test('(unit) a date range includes the whole last day', () => {
    const r = dateRange('createdAt', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-31T00:00:00Z'));
    expect(r.createdAt.$gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(r.createdAt.$lt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(dateRange('createdAt')).toBeNull();
  });

  test('(unit) CSV quotes every field and defuses spreadsheet formulas', () => {
    expect(cell('plain')).toBe('"plain"');
    expect(cell('say "hi", ok\nnext')).toBe('"say ""hi"", ok\nnext"');
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x']) expect(cell(evil)).toBe(`"'${evil.replace(/"/g, '""')}"`);
    expect(cell(null)).toBe('""');
    expect(cell(new Date('2026-01-02T03:04:05Z'))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(cell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsv(['a', 'b'], [[1, 2]])).toBe('"a","b"\r\n"1","2"\r\n');
  });
});

describe('requests: search, filter, sort, paginate', () => {
  async function seed() {
    const asha = await createUser({ role: 'STUDENT', department: 'CSE', email: 'asha.rao@example.com' });
    const ravi = await createUser({ role: 'STUDENT', department: 'CSE', email: 'ravi@example.com' });
    const meera = await createUser({ role: 'STUDENT', department: 'ME', email: 'meera@example.com' });
    await require('../models/User').updateOne({ _id: asha._id }, { name: 'Asha Rao' });
    await require('../models/User').updateOne({ _id: ravi._id }, { name: 'Ravi Kumar' });
    await require('../models/User').updateOne({ _id: meera._id }, { name: 'Meera Nair' });
    const day = (d) => new Date(`2026-03-${String(d).padStart(2, '0')}T10:00:00Z`);
    const mk = (s, over) => createRequest(s, { createdAt: over.createdAt, ...over });
    const r = {
      a1: await mk(asha, { documentType: 'Transcript', purpose: 'Needed for a visa application', status: 'PENDING', createdAt: day(1) }),
      a2: await mk(asha, { documentType: 'Bonafide Certificate', purpose: 'Bank education loan', status: 'FULFILLED', createdAt: day(2) }),
      r1: await mk(ravi, { documentType: 'Transcript', purpose: 'Internship abroad', status: 'UNDER_REVIEW', createdAt: day(3) }),
      m1: await mk(meera, { department: 'ME', documentType: 'Fee Receipt', purpose: 'Tax filing', status: 'REJECTED', createdAt: day(4) }),
    };
    await Request.collection.updateOne({ _id: r.a1._id }, { $set: { createdAt: day(1) } });
    for (const [k, d] of [['a2', 2], ['r1', 3], ['m1', 4]]) await Request.collection.updateOne({ _id: r[k]._id }, { $set: { createdAt: day(d) } });
    const clerk = await createUser({ role: 'CLERK', department: 'CSE' });
    const admin = await createUser({ role: 'ADMIN' });
    return { asha, ravi, meera, r, clerkAgent: await loginAgent(app, clerk), adminAgent: await loginAgent(app, admin), ashaAgent: await loginAgent(app, asha) };
  }

  test('filters narrow the list; the caller\'s scope always applies and can never be widened', async () => {
    const s = await seed();
    const get = (agent, qs) => agent.get(`/api/requests?${qs}`);
    expect(ids(await get(s.adminAgent, 'limit=100')).sort()).toEqual([s.r.a1, s.r.a2, s.r.r1, s.r.m1].map((x) => String(x._id)).sort());
    expect(ids(await get(s.adminAgent, 'status=FULFILLED'))).toEqual([String(s.r.a2._id)]);
    expect(ids(await get(s.adminAgent, 'department=ME'))).toEqual([String(s.r.m1._id)]);
    expect(ids(await get(s.adminAgent, 'department=me'))).toEqual([String(s.r.m1._id)]); // codes are case-insensitive
    expect(ids(await get(s.adminAgent, 'documentType=Transcript')).sort()).toEqual([String(s.r.a1._id), String(s.r.r1._id)].sort());
    expect(ids(await get(s.adminAgent, 'status=PENDING&documentType=Transcript'))).toEqual([String(s.r.a1._id)]);
    // The Clerk of CSE asking for ME gets nothing; a student asking for someone else's gets nothing.
    expect((await get(s.clerkAgent, 'department=ME')).body.data).toMatchObject({ items: [], total: 0 });
    expect(ids(await get(s.clerkAgent, 'department=CSE&limit=100'))).toHaveLength(3);
    expect(ids(await get(s.ashaAgent, 'limit=100'))).toHaveLength(2);
    expect((await get(s.ashaAgent, 'department=ME')).body.data.total).toBe(0);
  });

  test('search matches the purpose, the document type and (for staff) the student\'s name or e-mail; students only see their own', async () => {
    const s = await seed();
    const q = (agent, text) => agent.get(`/api/requests?q=${encodeURIComponent(text)}&limit=100`);
    expect(ids(await q(s.adminAgent, 'visa'))).toEqual([String(s.r.a1._id)]);
    expect(ids(await q(s.adminAgent, 'FEE rec'))).toEqual([String(s.r.m1._id)]);
    expect(ids(await q(s.adminAgent, 'ravi kumar'))).toEqual([String(s.r.r1._id)]);
    expect(ids(await q(s.adminAgent, 'asha.rao@'))).toEqual([String(s.r.a2._id), String(s.r.a1._id)]); // newest first
    expect((await q(s.adminAgent, 'nothing like this')).body.data.total).toBe(0);
    // A student cannot find other people's requests by searching for their names.
    expect((await q(s.ashaAgent, 'meera')).body.data.total).toBe(0);
    expect((await q(s.ashaAgent, 'visa')).body.data.total).toBe(1);
    // Regular-expression characters are literal text.
    expect((await q(s.adminAgent, '.*')).body.data.total).toBe(0);
    expect((await q(s.adminAgent, '(a+)+$')).body.data.total).toBe(0);
  });

  test('sorting works in both directions with a stable order; date ranges include their last day', async () => {
    const s = await seed();
    const order = async (qs) => ids(await s.adminAgent.get(`/api/requests?${qs}`));
    const newest = await order('sort=createdAt&order=desc');
    expect(newest).toEqual([s.r.m1, s.r.r1, s.r.a2, s.r.a1].map((x) => String(x._id)));
    expect(await order('sort=createdAt&order=asc')).toEqual([...newest].reverse());
    expect((await order('sort=documentType&order=asc')).length).toBe(4);
    expect((await order('from=2026-03-02&to=2026-03-03')).sort()).toEqual([s.r.a2, s.r.r1].map((x) => String(x._id)).sort());
    expect(await order('from=2026-03-04')).toEqual([String(s.r.m1._id)]);
    expect(await order('to=2026-03-01')).toEqual([String(s.r.a1._id)]);
  });

  test('bad parameters are refused with 400 and a clear field', async () => {
    const s = await seed();
    for (const qs of ['sort=password', 'order=sideways', 'from=yesterday', 'to=2026-13-45', 'limit=0', 'limit=101', 'page=0', `q=${'x'.repeat(81)}`, 'department=C$E', 'status=BOGUS']) {
      const res = await s.adminAgent.get(`/api/requests?${qs}`);
      expect([qs.slice(0, 20), res.status]).toEqual([qs.slice(0, 20), 400]);
    }
  });

  test('CSV export: the same filters and scope, safe cells, a download header and an audit entry', async () => {
    const s = await seed();
    await Request.collection.updateOne({ _id: s.r.a1._id }, { $set: { documentType: '=HYPERLINK("http://evil.example","click")' } });
    const res = await s.adminAgent.get('/api/requests/export.csv?status=PENDING');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="requests-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('"id","submitted","updated","document type","department","status","student"');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(`); // defused: no cell starts with =
    expect(lines[1]).toContain('"Asha Rao"');
    expect((await AuditLog.findOne({ action: 'DATA_EXPORTED' })).details).toEqual({ kind: 'requests', rows: 1 });

    // A student's export holds only their own rows and has no student column; staff are scope-limited too.
    const mine = await s.ashaAgent.get('/api/requests/export.csv');
    expect(mine.text.trim().split('\r\n')).toHaveLength(3);
    expect(mine.text.split('\r\n')[0]).not.toContain('student');
    expect(mine.text).not.toContain('Meera');
    const clerk = await s.clerkAgent.get('/api/requests/export.csv?department=ME');
    expect(clerk.text.trim().split('\r\n')).toHaveLength(1); // header only
    expect((await request(app).get('/api/requests/export.csv')).status).toBe(401);
    expect((await s.adminAgent.get('/api/requests/export.csv?sort=nope')).status).toBe(400);
  });

  test('the export is capped, and says so', async () => {
    const s = await seed();
    const tenantId = getDefaultTenant()._id;
    const def = await WorkflowDefinition.findOne({});
    const docs = Array.from({ length: 5100 }, (_, i) => ({
      tenantId, studentId: s.asha._id, department: 'CSE', documentType: 'Transcript', purpose: 'Bulk row for the export cap',
      status: 'PENDING', workflowDefinitionId: def._id, currentStepIndex: 0, statusHistory: [], createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date(),
    }));
    await Request.collection.insertMany(docs);
    const res = await s.adminAgent.get('/api/requests/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.text.trim().split('\r\n')).toHaveLength(5001); // header + 5000 rows
  });
});

describe('users and the audit log: search, filters, sort, export', () => {
  async function seedUsers() {
    const admin = await createUser({ role: 'ADMIN', email: 'admin.boss@example.com' });
    const users = {
      a: await createUser({ role: 'CLERK', department: 'CSE', email: 'carol.clerk@example.com' }),
      b: await createUser({ role: 'HOD', department: 'ME', email: 'henry.hod@example.com', isActive: false }),
      c: await createUser({ role: 'STUDENT', department: 'CSE', email: 'sam.student@example.com' }),
    };
    const U = require('../models/User');
    await U.updateOne({ _id: users.a._id }, { name: 'Carol Clerk' });
    await U.updateOne({ _id: users.b._id }, { name: 'Henry Hod' });
    await U.updateOne({ _id: users.c._id }, { name: 'Sam Student' });
    return { admin, users, agent: await loginAgent(app, admin) };
  }

  test('users: search, role, active, department, sort and export', async () => {
    const { users, agent } = await seedUsers();
    const get = (qs) => agent.get(`/api/admin/users?${qs}`);
    expect(ids(await get('q=carol'))).toEqual([String(users.a._id)]);
    expect(ids(await get('q=HENRY.HOD@'))).toEqual([String(users.b._id)]);
    expect(ids(await get('role=STUDENT'))).toEqual([String(users.c._id)]);
    expect(ids(await get('active=false'))).toEqual([String(users.b._id)]);
    expect(ids(await get('active=true&department=CSE&limit=100')).sort()).toEqual([users.a, users.c].map((u) => String(u._id)).sort());
    const byName = (await get('sort=name&order=asc&limit=100')).body.data.items.map((u) => u.name);
    expect(byName).toEqual([...byName].sort((x, y) => x.localeCompare(y)));
    expect((await get('sort=passwordHash')).status).toBe(400);
    expect((await get('active=maybe')).status).toBe(400);

    const csv = await agent.get('/api/admin/users/export.csv?role=CLERK');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('"carol.clerk@example.com"');
    expect(csv.text).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(csv.text.split('\r\n')[0]).toContain('"two-step"');
    expect((await AuditLog.findOne({ action: 'DATA_EXPORTED', 'details.kind': 'users' })).details.rows).toBe(1);
    const student = await loginAgent(app, users.c);
    expect((await student.get('/api/admin/users/export.csv')).status).toBe(403);
  });

  test('audit log: filters by date range, action text and sort; export carries the hashes', async () => {
    const { users, agent } = await seedUsers();
    await loginAgent(app, users.a); // USER_LOGIN
    const list = await agent.get('/api/admin/audit-logs?limit=100');
    expect(list.body.data.items.length).toBeGreaterThanOrEqual(2);
    expect((await agent.get('/api/admin/audit-logs?q=login')).body.data.items.every((e) => e.action === 'USER_LOGIN')).toBe(true);
    const future = await agent.get('/api/admin/audit-logs?from=2999-01-01');
    expect(future.body.data.total).toBe(0);
    expect((await agent.get('/api/admin/audit-logs?to=2000-01-01')).body.data.total).toBe(0);
    const asc = (await agent.get('/api/admin/audit-logs?sort=seq&order=asc&limit=100')).body.data.items.map((e) => e.seq);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    expect((await agent.get('/api/admin/audit-logs?sort=details')).status).toBe(400);

    const csv = await agent.get('/api/admin/audit-logs/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')[0]).toBe('"seq","time","actor","role","action","request","details","hash"');
    expect(csv.text).toMatch(/"[0-9a-f]{64}"/);
    expect(csv.text).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  test('the lists of another institution never appear', async () => {
    const B = await makeTenant('beta-college');
    const { agent } = await seedUsers();
    const outsider = await createUser({ role: 'CLERK', tenant: B, email: 'carol.clerk@example.com' });
    expect(ids(await agent.get('/api/admin/users?q=carol&limit=100'))).not.toContain(String(outsider._id));
    expect((await agent.get('/api/admin/users/export.csv?q=carol')).text.match(/carol\.clerk@example\.com/g)).toHaveLength(1);
    expect(await runAsTenant(B._id, () => require('../models/User').countDocuments({ email: 'carol.clerk@example.com' }))).toBe(1);
    void runUnscoped;
  });
});

describe('large lists', () => {
  test('1,200 rows: pages are complete, in order, without gaps or repeats, and fast enough', async () => {
    const asha = await createUser({ role: 'STUDENT', department: 'CSE' });
    const admin = await createUser({ role: 'ADMIN' });
    const def = await WorkflowDefinition.findOne({});
    const tenantId = getDefaultTenant()._id;
    const base = Date.now();
    const docs = Array.from({ length: 1200 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(), tenantId, studentId: asha._id, department: 'CSE', documentType: i % 2 ? 'Transcript' : 'Fee Receipt', purpose: `Row number ${i} for paging`,
      status: 'PENDING', workflowDefinitionId: def._id, currentStepIndex: 0, statusHistory: [], createdAt: new Date(base - i * 1000), updatedAt: new Date(base),
    }));
    await Request.collection.insertMany(docs);
    const agent = await loginAgent(app, admin);

    const seen = [];
    const t0 = Date.now();
    for (let page = 1; page <= 12; page += 1) {
      const res = await agent.get(`/api/requests?limit=100&page=${page}`);
      expect(res.body.data.total).toBe(1200);
      seen.push(...ids(res));
    }
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(new Set(seen).size).toBe(1200); // no repeats
    expect(seen).toEqual([...docs].sort((a, b) => b.createdAt - a.createdAt).map((d) => String(d._id))); // exact order
    expect((await agent.get('/api/requests?limit=100&page=13')).body.data.items).toHaveLength(0);
    expect((await agent.get('/api/requests?documentType=Transcript&limit=100')).body.data.total).toBe(600);
    expect((await agent.get(`/api/requests?q=${encodeURIComponent('number 7')}&limit=100`)).body.data.total).toBe(111); // "number 7", "number 70-79", "number 700-799"
  });
});
