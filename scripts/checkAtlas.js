'use strict';

// Verifies the MongoDB Atlas connection WITHOUT ever printing the connection
// string, credentials or any document. Reads MONGODB_ATLAS_URI from your local
// .env (never commit that file).
//
//   npm run check:atlas
//
// What it proves:
//   1. the URI is set, is a remote (non-local) MongoDB, and the server accepts the login
//   2. the deployment is a replica set with a writable primary
//   3. a multi-document transaction can start and commit (it only READS, so no data is
//      written and no collection is created)
//
// Exit codes: 0 = all good, 1 = connection/capability problem, 2 = not configured.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { isLocalMongoUri } = require('../server/config/mongoUri');

const uri = process.env.MONGODB_ATLAS_URI || '';

const scrub = (message) => String(message).replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, '[connection string hidden]');

function hint(message) {
  const m = String(message);
  if (/auth|credentials|bad auth/i.test(m)) return 'The database user or password looks wrong (Atlas > Database Access).';
  if (/ENOTFOUND|querySrv|ECONNREFUSED|timed out|Server selection|ReplicaSetNoPrimary/i.test(m)) {
    return "Cannot reach the cluster. Check Atlas > Network Access: this computer's current IP must be allowed.";
  }
  return '';
}

(async () => {
  if (!uri) {
    console.error('MONGODB_ATLAS_URI is not set.');
    console.error('Add MONGODB_ATLAS_URI=<your Atlas connection string> to your local .env (never commit it), then run: npm run check:atlas');
    process.exit(2);
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    console.error('MONGODB_ATLAS_URI is not a MongoDB connection string (expected mongodb+srv://...).');
    process.exit(2);
  }
  const whitespace = (uri.match(/\s/g) || []).length;
  if (whitespace > 0) {
    console.error(`MONGODB_ATLAS_URI contains ${whitespace} whitespace character(s) (spaces, tabs or line breaks).`);
    console.error('A connection string cannot contain whitespace. Open your .env, find the MONGODB_ATLAS_URI line and delete any');
    console.error('spaces, especially around the username and password. Special characters in the password must be %-encoded instead.');
    process.exit(2);
  }
  if (isLocalMongoUri(uri)) {
    console.error('MONGODB_ATLAS_URI points to a local MongoDB. This check is for Atlas only.');
    process.exit(2);
  }

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000 }).asPromise();
  let ok = true;
  try {
    const hello = await conn.db.admin().command({ hello: 1 });
    const replica = Boolean(hello.setName);
    console.log('Connected to MongoDB: yes');
    console.log(`Replica set: ${replica ? 'yes' : 'NO (transactions would not work)'}`);
    console.log(`Writable primary: ${hello.isWritablePrimary ? 'yes' : 'no'}`);
    ok = replica && Boolean(hello.isWritablePrimary);

    const session = await conn.startSession();
    try {
      await session.withTransaction(async () => {
        await conn.db.collection('__connectivity_check__').countDocuments({}, { session });
      });
      console.log('Multi-document transaction (read-only, nothing written): OK');
    } catch (err) {
      ok = false;
      console.log(`Multi-document transaction: FAILED (${scrub(err.message)})`);
    } finally {
      await session.endSession();
    }
  } finally {
    await conn.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(`Atlas check failed: ${scrub(err.message)}`);
  const h = hint(err.message);
  if (h) console.error(h);
  process.exit(1);
});
