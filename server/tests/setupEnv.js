'use strict';

// Loaded by Jest before any test file. Test-only values; no real secrets.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.JWT_EXPIRES_IN = '2h';
// Uploaded test files go to a throwaway temp folder, never the real storage.
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'sdw-test-uploads');

// MONGODB_URI_TEST comes from .env (Docker replica set) or the CI environment.
require('dotenv').config({ quiet: true });
