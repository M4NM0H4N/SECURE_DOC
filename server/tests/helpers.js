'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const createApp = require('../app');
const { isLocalMongoUri } = require('../config/mongoUri');
const User = require('../models/User');
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
  await User.init();
  await Request.init();
  await AuditLog.init();
}

async function stopDb() {
  await mongoose.connection.dropDatabase();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  await mongoose.disconnect();
}

async function clearDb() {
  await AuditLog.collection.deleteMany({}); // native call: the model blocks deletes on purpose
  await Request.deleteMany({});
  await User.deleteMany({});
}

const makeApp = (opts) => createApp(opts);
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

async function createUser({ role = 'STUDENT', department = 'CSE', isActive = true, email, password = 'Passw0rdTest' } = {}) {
  const passwordHash = await bcrypt.hash(password, 4);
  return User.create({
    name: `${role} User`,
    email: email || `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    passwordHash,
    role,
    department: role === 'ADMIN' ? null : department,
    isActive,
  });
}

// Returns a supertest agent with the auth cookie set after a real login.
async function loginAgent(app, user, password = 'Passw0rdTest') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return agent;
}

function forgeToken(userId, opts = {}) {
  return jwt.sign({ sub: String(userId) }, opts.secret || process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: opts.expiresIn || '2h',
  });
}

async function createRequest(student, overrides = {}) {
  return Request.create({
    studentId: student._id,
    department: student.department,
    documentType: 'Bonafide Certificate',
    purpose: 'Needed for a scholarship application',
    statusHistory: [{ from: null, to: 'PENDING', by: student._id }],
    ...overrides,
  });
}

module.exports = {
  createRequest, startDb, stopDb, clearDb, makeApp, CSRF, createUser, loginAgent, forgeToken, request };
