'use strict';

// Shared by the Playwright config and the global setup. The database is ALWAYS a local one whose name
// contains "e2e"; anything else is refused, so these tests can never reach a real database.
require('dotenv').config({ quiet: true });
const { isLocalMongoUri } = require('../server/config/mongoUri');

const PORT = 3201;
// A throw-away password for the seeded demo accounts. Local test data only.
const DEMO_PASSWORD = 'E2eDemoPass1';

function e2eUri() {
  let uri = process.env.E2E_MONGODB_URI;
  if (!uri && process.env.MONGODB_URI_TEST) uri = process.env.MONGODB_URI_TEST.replace(/\/([^/?]*)_test(\?|$)/, '/$1_e2e$2');
  if (!uri) throw new Error('Set E2E_MONGODB_URI (a local MongoDB database whose name contains "e2e") or MONGODB_URI_TEST');
  if (!isLocalMongoUri(uri)) throw new Error('E2E database must be a local MongoDB; refusing to run');
  const name = (/\/([^/?]+)(\?|$)/.exec(uri) || [])[1] || '';
  if (!/e2e/i.test(name)) throw new Error('E2E database name must contain "e2e"; refusing to run');
  return uri;
}

// Throwaway keys for the local e2e server and its seed script. Test values only; never used anywhere else.
const E2E_KEYS = {
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret-1234',
  MFA_ENCRYPTION_KEY: 'e2e-mfa-key-e2e-mfa-key-e2e-mfa-key-1234',
  VERIFY_SIGNING_KEY: 'e2e-verify-key-e2e-verify-key-e2e-1234',
  WEBHOOK_ENCRYPTION_KEY: 'e2e-webhook-key-e2e-webhook-key-e2e-1234',
};

module.exports = { e2eUri, PORT, DEMO_PASSWORD, E2E_KEYS };
