'use strict';

// Demo data for presentations and screenshots.
//   npm run seed:demo          create demo accounts + requests in every status
//   npm run seed:demo:clean    remove everything this script created
//
// It uses the real services, so the workflow, files and audit trail are genuine.
// Safety: refuses to run in production; the password comes from DEMO_PASSWORD
// (never hardcoded); all demo accounts end in ".demo@example.com".
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const config = require('../server/config/env');
const User = require('../server/models/User');
const Request = require('../server/models/Request');
const AuditLog = require('../server/models/AuditLog');
const authService = require('../server/services/authService');
const requestService = require('../server/services/requestService');
const documentService = require('../server/services/documentService');
const { transition } = require('../server/services/transitionService');

const DEMO_EMAIL = /\.demo@example\.com$/;

const ACCOUNTS = [
  ['Demo Admin', 'admin.demo@example.com', 'ADMIN', null],
  ['Demo Clerk (CSE)', 'clerk.cse.demo@example.com', 'CLERK', 'CSE'],
  ['Demo HOD (CSE)', 'hod.cse.demo@example.com', 'HOD', 'CSE'],
  ['Demo Clerk (ME)', 'clerk.me.demo@example.com', 'CLERK', 'ME'],
  ['Demo HOD (ME)', 'hod.me.demo@example.com', 'HOD', 'ME'],
  ['Asha Rao', 'asha.demo@example.com', 'STUDENT', 'CSE'],
  ['Ravi Kumar', 'ravi.demo@example.com', 'STUDENT', 'CSE'],
  ['Meera Nair', 'meera.demo@example.com', 'STUDENT', 'ME'],
];

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
);

async function clean() {
  const users = await User.find({ email: DEMO_EMAIL });
  const ids = users.map((u) => u._id);
  const requests = await Request.find({ studentId: { $in: ids } }).select('+documentPath');
  for (const r of requests) {
    if (r.documentPath) fs.rmSync(path.join(config.uploadDir, r.documentPath), { force: true });
  }
  // Native call: the AuditLog model deliberately blocks deletes.
  await AuditLog.collection.deleteMany({ $or: [{ actorId: { $in: ids } }, { requestId: { $in: requests.map((r) => r._id) } }] });
  await Request.deleteMany({ _id: { $in: requests.map((r) => r._id) } });
  await User.deleteMany({ _id: { $in: ids } });
  console.log(`Removed ${ids.length} demo users and ${requests.length} demo requests.`);
}

async function seed() {
  const password = process.env.DEMO_PASSWORD || '';
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Set DEMO_PASSWORD in .env (min 8 characters, with a letter and a number).');
  }
  if (await User.exists({ email: DEMO_EMAIL })) {
    console.log('Demo data already exists. Run "npm run seed:demo:clean" first to recreate it.');
    return;
  }

  const hash = await authService.hashPassword(password);
  const u = {};
  for (const [name, email, role, department] of ACCOUNTS) {
    u[email.split('.demo@')[0]] = await User.create({ name, email, passwordHash: hash, role, department });
  }
  const { asha, ravi, meera } = u;
  const clerkCse = u['clerk.cse'];
  const hodCse = u['hod.cse'];
  const clerkMe = u['clerk.me'];
  const hodMe = u['hod.me'];

  const submit = (student, documentType, purpose) => requestService.createRequest(student, { documentType, purpose });
  const review = (clerk, r) => transition(clerk, r._id, 'UNDER_REVIEW');
  const approve = (hod, r) => transition(hod, r._id, 'APPROVED');

  // Asha: one request in every status
  const full = await submit(asha, 'Bonafide Certificate', 'Required for an education loan application at the bank.');
  await review(clerkCse, full);
  await approve(hodCse, full);
  await documentService.uploadFulfilment(clerkCse, full._id, { buffer: PDF, size: PDF.length, originalname: 'bonafide-certificate.pdf' });

  const approved = await submit(asha, 'Transfer Certificate', 'Needed for admission to another institution.');
  await review(clerkCse, approved);
  await approve(hodCse, approved);

  const inReview = await submit(asha, 'Fee Receipt', 'Needed for scholarship reimbursement claim.');
  await review(clerkCse, inReview);

  await submit(asha, 'Transcript', 'Required for a higher studies application abroad.');

  const rejected = await submit(asha, 'Character Certificate', 'Required for a passport application.');
  await review(clerkCse, rejected);
  await transition(hodCse, rejected._id, 'REJECTED', {
    reason: 'Disciplinary clearance is pending. Please contact the department office first.',
  });

  // Other students, so scope limits are visible
  await submit(ravi, 'Transcript', 'Needed for an internship application.');
  const ravi2 = await submit(ravi, 'Other', 'Letter confirming enrolment for a visa application.');
  await review(clerkCse, ravi2);

  await submit(meera, 'Bonafide Certificate', 'Required for a bank account opening.');
  const meera2 = await submit(meera, 'Fee Receipt', 'Needed for tax filing purposes.');
  await review(clerkMe, meera2);
  void hodMe;

  console.log('Demo data created: 8 accounts, 9 requests across every status.');
  console.log('Sign in with any "*.demo@example.com" account using DEMO_PASSWORD from your .env file.');
  console.log('Accounts: ' + ACCOUNTS.map((a) => a[1]).join(', '));
}

(async () => {
  await mongoose.connect(config.mongoUri);
  try {
    if (process.argv.includes('--clean')) await clean();
    else await seed();
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error('Demo seed failed:', err.message);
  process.exit(1);
});
