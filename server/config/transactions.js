'use strict';

const mongoose = require('mongoose');

// Transactions need a replica set (or Atlas). A standalone mongod cannot do them.
// We detect the mode once and make it explicit instead of assuming.
//   'replica'    -> multi-document transactions: state change + audit are atomic
//   'standalone' -> no transactions: see docs/TRANSACTIONS.md for what that means
let mode = null;

async function detectMode() {
  if (mode) return mode;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    mode = hello.setName ? 'replica' : 'standalone';
  } catch (_err) {
    mode = 'standalone';
  }
  return mode;
}

function setModeForTests(value) {
  mode = value;
}

function resetMode() {
  mode = null;
}

// Runs fn(session). With a replica set everything inside commits or rolls back
// together (and transient write conflicts are retried). Without one, fn runs with
// session = null, so each write stands alone.
async function runInTransaction(fn) {
  if ((await detectMode()) === 'replica') {
    return mongoose.connection.transaction((session) => fn(session));
  }
  return fn(null);
}

module.exports = { detectMode, runInTransaction, setModeForTests, resetMode };
