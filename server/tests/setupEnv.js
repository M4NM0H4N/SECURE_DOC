'use strict';

// Loaded by Jest before any test file. Test-only values; no real secrets.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.JWT_EXPIRES_IN = '2h';
// Uploaded test files go to a throwaway temp folder, never the real storage.
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'sdw-test-uploads');

// MONGODB_URI_TEST comes from .env (Docker replica set) or the CI environment.
require('dotenv').config({ quiet: true });
// S3: a throwaway key so TOTP secrets can be encrypted in tests.
process.env.MFA_ENCRYPTION_KEY = 'test-mfa-key-test-mfa-key-test-mfa-key-1234';
// S4: throwaway key for document verification codes; scanning stays off unless a test turns it on.
process.env.VERIFY_SIGNING_KEY = 'test-verify-key-test-verify-key-test-1234';
process.env.SCAN_MODE = 'off';
process.env.STORAGE_DRIVER = 'local';
// S5: mail goes to the in-memory outbox in tests unless a test chooses another provider.
process.env.MAIL_PROVIDER = 'outbox';
// S7: throwaway key so webhook secrets can be encrypted in tests.
process.env.WEBHOOK_ENCRYPTION_KEY = 'test-webhook-key-test-webhook-key-1234';
