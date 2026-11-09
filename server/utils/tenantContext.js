'use strict';

// Per-request tenant context (AsyncLocalStorage). The tenant middleware opens it, and the
// tenantScope plugin reads it, so every model query is filtered by tenantId without each
// service having to remember to do it. A query with no context fails loudly.
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const als = new AsyncLocalStorage();

// Test-only fallback so direct model calls in tests can run without a request. It is
// refused outside NODE_ENV=test and is never consulted while a real context is open.
let testFallback = null;

function toObjectId(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

// fn may return a lazy Mongoose Query. It must be awaited INSIDE the context, otherwise the
// query would execute later with no tenant (or the test fallback). Hence the async wrapper.
function runAsTenant(tenantId, fn) {
  return als.run({ tenantId: toObjectId(tenantId) }, async () => await fn());
}

// Explicit, greppable opt-out for platform code (signup, migration, SUPER_ADMIN, tests).
function runUnscoped(fn) {
  return als.run({ unscoped: true }, async () => await fn());
}

function setTestFallback(tenantId) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Tenant fallback is only available in tests');
  testFallback = tenantId ? toObjectId(tenantId) : null;
}

// Returns { tenantId } | { unscoped: true }, or throws when there is no context at all.
function currentScope(modelName) {
  const store = als.getStore();
  if (store) return store;
  if (testFallback) return { tenantId: testFallback };
  throw new Error(`Tenant context missing: refusing an unscoped ${modelName} operation`);
}

module.exports = { runAsTenant, runUnscoped, setTestFallback, currentScope, toObjectId };
