'use strict';

// Build verification for CI: there is no compile step (plain Node + static
// client), so "build" means: the app loads, the required files exist, and a
// real HTTP server answers correctly. No database is needed.
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Throwaway value, only so the config loader accepts the environment.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-build-check-ci-build-check-ci-build-check';

const root = path.resolve(__dirname, '..');
const required = [
  'client/login.html',
  'client/register.html',
  'client/student/index.html',
  'client/clerk/index.html',
  'client/hod/index.html',
  'client/admin/index.html',
  'client/admin/audit.html',
  'client/request.html',
  'client/404.html',
  'client/css/tokens.css',
  'server/app.js',
  'server/server.js',
  'server/config/storage.js',
  'server/config/mongoUri.js',
  'scripts/seedSuperAdmin.js',
  'scripts/migrateToTenants.js',
  'client/home.html',
  'client/signup.html',
  'client/admin/settings.html',
  'client/principal/index.html',
  'client/js/settings.js',
  'client/account.html',
  'client/forgot-password.html',
  'client/reset-password.html',
  'client/accept-invite.html',
  'client/verify-email.html',
  'server/utils/totp.js',
  'server/storage/index.js',
  'server/storage/s3Adapter.js',
  'server/storage/sigv4.js',
  'scripts/storageCleanup.js',
  'client/verify.html',
  'client/analytics.html',
  'client/js/analytics.js',
  'client/js/branding.js',
  'client/css/print.css',
  'client/admin/integrations.html',
  'client/js/integrations.js',
  'server/openapi.js',
  'docs/openapi.json',
  'client/notifications.html',
  'client/js/notifications.js',
  'client/admin/notifications.html',
  'client/js/notifications-admin.js',
  'server/services/notificationWorker.js',
  'scripts/worker.js',
  'client/js/verify.js',
  'client/js/qr.js',
  'client/js/vendor/qrcode.js',
  '.env.example',
];

function fail(msg) {
  console.error(`BUILD CHECK FAILED: ${msg}`);
  process.exit(1);
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: urlPath, headers: { Accept: 'text/html' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

(async () => {
  for (const f of required) {
    if (!fs.existsSync(path.join(root, f))) fail(`missing file ${f}`);
  }
  if (fs.existsSync(path.join(root, '.env')) === false && !fs.existsSync(path.join(root, '.env.example'))) {
    fail('.env.example is missing');
  }

  const createApp = require('../server/app');
  const server = http.createServer(createApp()).listen(0);
  const { port } = server.address();
  try {
    const checks = [
      ['/login.html', 200],
      ['/t/demo-college/login.html', 200], // the client is served under an institution address
      ['/t/demo-college/verify.html', 200], // the public verification page
      ['/api/platform/tenants', 401], // platform routes reject anonymous callers
      ['/api/auth/me', 404], // the old un-prefixed API no longer exists
      ['/definitely-not-a-page', 404],
      ['/.env', 404],
      ['/healthz', 503], // no database in this check, so "not ready" is the correct answer
    ];
    for (const [url, expected] of checks) {
      const status = await get(port, url);
      if (status !== expected) fail(`GET ${url} returned ${status}, expected ${expected}`);
    }
  } finally {
    server.close();
  }
  console.log(`Build verification passed (${required.length} files, 8 HTTP checks).`);
  process.exit(0);
})().catch((err) => fail(err.message));
