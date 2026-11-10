'use strict';

// Browser tests (end-to-end flows, accessibility, responsive layout). Not part of `npm test`.
//   npm run test:e2e
// They start the real server on a throw-away LOCAL database (see e2e/global-setup.js) and never touch
// any other database. Locally they use your installed Chrome; in CI they use Playwright's Chromium
// (npx playwright install --with-deps chromium). Set PW_CHANNEL=msedge (or '') to change that.
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const os = require('os');
const { e2eUri, PORT, DEMO_PASSWORD } = require('./e2e/env');

const channel = process.env.PW_CHANNEL !== undefined ? process.env.PW_CHANNEL || undefined : process.env.CI ? undefined : 'chrome';

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: './reports/e2e-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'reports/e2e-report' }]],
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45000,
  globalSetup: require.resolve('./e2e/global-setup.js'),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel,
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel } }],
  webServer: {
    command: 'node server/server.js',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MONGODB_URI: e2eUri(),
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret-1234',
      MFA_ENCRYPTION_KEY: 'e2e-mfa-key-e2e-mfa-key-e2e-mfa-key-1234',
      VERIFY_SIGNING_KEY: 'e2e-verify-key-e2e-verify-key-e2e-1234',
      WEBHOOK_ENCRYPTION_KEY: 'e2e-webhook-key-e2e-webhook-key-e2e-1234',
      STORAGE_DRIVER: 'local',
      UPLOAD_DIR: path.join(os.tmpdir(), 'sdw-e2e-uploads'),
      SCAN_MODE: 'off',
      MAIL_PROVIDER: 'outbox',
      WORKER_INLINE: 'true',
      LOG_LEVEL: 'warn',
      DEMO_PASSWORD,
    },
  },
});
