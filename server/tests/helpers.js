'use strict';

const supertest = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const createApp = require('../app');
const { isLocalMongoUri } = require('../config/mongoUri');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Department = require('../models/Department');
const DocumentType = require('../models/DocumentType');
const WorkflowDefinition = require('../models/WorkflowDefinition');
const Document = require('../models/Document');
const AuditChain = require('../models/AuditChain');
const { seedDefaults } = require('../services/institutionService');
const { runAsTenant, runUnscoped, setTestFallback } = require('../utils/tenantContext');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const fs = require('fs');

async function startDb() {
  const uri = process.env.MONGODB_URI_TEST;
  if (!uri || !/test/i.test(uri)) {
    throw new Error("MONGODB_URI_TEST must be set and point to a *test* database");
  }
  // Tests create and DROP their database. They must never run against Atlas or any
  // remote server, even one whose database name contains "test".
  if (!isLocalMongoUri(uri)) {
    throw new Error('MONGODB_URI_TEST must point to a local MongoDB (localhost / 127.0.0.1); refusing to run tests');
  }
  // Jest blocks the driver's dynamic import('os'), which drops the handshake
  // metadata and makes the server refuse the connection. Supply it explicitly.
  await mongoose.connect(uri, { runtimeAdapters: { os: require('os') } });
  await Tenant.init();
  await Department.init();
  await DocumentType.init();
  await WorkflowDefinition.init();
  await Document.init();
  await AuditChain.init();
  await User.init();
  await Request.init();
  await AuditLog.init();
  await ensureDefaultTenant();
}

const DEFAULT_SLUG = 'default';
let defaultTenant = null;

// Most tests are single-institution: they run as the 'default' tenant. Direct model calls in
// a test fall back to it; HTTP requests always go through the real tenant middleware.
async function ensureDefaultTenant() {
  defaultTenant = await runUnscoped(() => Tenant.findOneAndUpdate(
    { slug: DEFAULT_SLUG },
    { $setOnInsert: { name: 'Default Institution', slug: DEFAULT_SLUG } },
    { upsert: true, returnDocument: 'after' }
  ));
  setTestFallback(defaultTenant._id);
  await resetConfig(defaultTenant);
  return defaultTenant;
}

// Puts an institution's departments, document types and workflow back to the seeded defaults.
async function resetConfig(tenant) {
  for (const M of [Department, DocumentType, WorkflowDefinition]) await M.collection.deleteMany({ tenantId: tenant._id });
  await runAsTenant(tenant._id, () => seedDefaults());
}

const getDefaultTenant = () => defaultTenant;

async function makeTenant(slug, name) {
  const tenant = await runUnscoped(() => Tenant.create({ slug, name: name || slug + ' institute' }));
  await runAsTenant(tenant._id, () => seedDefaults());
  return tenant;
}

async function stopDb() {
  await mongoose.connection.dropDatabase();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  await mongoose.disconnect();
}

async function clearDb() {
  // Native calls: the model blocks audit deletes on purpose, and this clears every tenant.
  await AuditLog.collection.deleteMany({});
  await AuditChain.collection.deleteMany({});
  await Request.collection.deleteMany({});
  await Document.collection.deleteMany({});
  await User.collection.deleteMany({});
  for (const M of [Department, DocumentType, WorkflowDefinition]) await M.collection.deleteMany({ tenantId: { $ne: defaultTenant._id } });
  await Tenant.collection.deleteMany({ slug: { $ne: DEFAULT_SLUG } });
  // Tests may edit the default institution's configuration; every test starts from the defaults.
  await resetConfig(defaultTenant);
}

const makeApp = (opts) => createApp(opts);
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

async function createUser({ role = 'STUDENT', department = 'CSE', isActive = true, email, password = 'Passw0rdTest', tenant } = {}) {
  const passwordHash = await bcrypt.hash(password, 4);
  const make = () => User.create({
    name: `${role} User`,
    email: email || `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    passwordHash,
    role,
    department: role === 'ADMIN' ? null : department,
    isActive,
  });
  return tenant ? runAsTenant(tenant._id, make) : make();
}

// Returns a supertest agent with the auth cookie set after a real login.
async function loginAgent(app, user, password = 'Passw0rdTest', slug) {
  const agent = request.agent(app, slug);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return agent;
}

function forgeToken(userId, opts = {}) {
  return jwt.sign({ sub: String(userId), tid: String(opts.tenantId || defaultTenant._id), ver: opts.ver ?? 0 }, opts.secret || process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: opts.expiresIn || '2h',
  });
}

async function createRequest(student, overrides = {}, tenant) {
  const make = async () => {
    const def = await WorkflowDefinition.findOne({}).sort({ version: -1 });
    const last = def.steps.length - 1;
    const status = overrides.status || 'PENDING';
    const stepIndex = { PENDING: 0, NEEDS_INFO: 0, UNDER_REVIEW: 1 }[status] ?? last;
    return Request.create({
      workflowDefinitionId: def._id,
      currentStepIndex: Math.min(stepIndex, last),
    studentId: student._id,
    department: student.department,
    documentType: 'Bonafide Certificate',
    purpose: 'Needed for a scholarship application',
    statusHistory: [{ from: null, to: 'PENDING', by: student._id }],
      ...overrides,
    });
  };
  return tenant ? runAsTenant(tenant._id, make) : make();
}

// Staff are invited, never given a password by an admin. This runs the real flow: the admin
// creates an invitation, then the invitee accepts it with their own password. Returns the
// accept response (201 with the user), or the invitation response when it was refused.
async function addStaff(app, adminAgent, { name, email, password = 'StaffPass123', role, department }, slug = DEFAULT_SLUG) {
  const inv = await adminAgent.post('/api/admin/invites').set(CSRF).send({ email, role, department, name });
  if (inv.status !== 201) return inv;
  const token = new URL(inv.body.data.link).searchParams.get('token');
  return request(app, slug).post('/api/auth/accept-invite').set(CSRF).send({ token, name, password });
}

// Tests write '/api/auth/login'; the app now serves '/api/t/<slug>/auth/login'. This wrapper
// adds the tenant segment so the real routing is exercised. Platform and already-prefixed
// URLs pass through unchanged.
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
function withTenantPath(target, slug) {
  return new Proxy(target, {
    get(obj, prop) {
      if (METHODS.includes(prop)) {
        return (url, ...rest) => {
          const u = typeof url === 'string' && url.startsWith('/api/') && !url.startsWith('/api/platform') && !url.startsWith('/api/t/')
            ? '/api/t/' + slug + url.slice(4)
            : url;
          return obj[prop](u, ...rest);
        };
      }
      const v = obj[prop];
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  });
}
const request = (app, slug = DEFAULT_SLUG) => withTenantPath(supertest(app), slug);
request.agent = (app, slug = DEFAULT_SLUG) => withTenantPath(supertest.agent(app), slug);

module.exports = {
  addStaff,
  getDefaultTenant, makeTenant, DEFAULT_SLUG, runAsTenant, runUnscoped,
  createRequest, startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, forgeToken, request };
