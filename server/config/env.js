'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const { isLocalMongoUri } = require('./mongoUri');

const isProd = process.env.NODE_ENV === 'production';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Number of reverse-proxy hops to trust for the client IP (rate limiting).
// Render (and most hosts) put exactly one proxy in front of the app. Only whole
// numbers are accepted: "true" would trust spoofable headers from anyone.
function parseTrustProxy(value) {
  if (value === undefined || value === '') return isProd ? 1 : 0;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.toLowerCase() === 'false') return 0;
  throw new Error('TRUST_PROXY must be a whole number of proxy hops (or "false")');
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: Number(process.env.PORT) || 3000,
  // Production binds all IPv4 interfaces (Render requires 0.0.0.0). In development
  // the Node default is kept, so existing local behaviour does not change.
  host: process.env.HOST || (isProd ? '0.0.0.0' : undefined),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  cookieName: process.env.COOKIE_NAME || 'sdw_token',
  // Institution self-signup is closed unless the owner sets SIGNUP_KEY (until e-mail
  // verification exists in S3). Never logged, never sent to the client.
  signupKey: process.env.SIGNUP_KEY || '',
  // Public origin used in links sent to people (invites, password reset, e-mail verification),
  // for example https://docflow.example.com. Never taken from the request's Host header, which
  // a visitor could forge to poison a reset link.
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  // Key that encrypts TOTP secrets at rest (32+ characters). MFA is unavailable while unset.
  mfaKey: process.env.MFA_ENCRYPTION_KEY || '',
  // Students must verify their e-mail address before submitting requests. Off by default until
  // e-mail delivery exists (S5); admins can mark a student verified meanwhile.
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
  cookieMaxAgeMs: 2 * 60 * 60 * 1000,
  // Private storage, outside client/ (never served statically).
  uploadDir: path.resolve(__dirname, '..', '..', process.env.UPLOAD_DIR || 'server/uploads'),
  uploadDirIsDefault: !process.env.UPLOAD_DIR,
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024,
  // Document storage (S4). 'local' = UPLOAD_DIR on disk; 's3' = any S3-compatible private bucket
  // (Cloudflare R2 recommended). Keys are always prefixed by tenant.
  storageDriver: (process.env.STORAGE_DRIVER || 'local').trim(),
  s3: {
    endpoint: (process.env.S3_ENDPOINT || '').trim().replace(/\/+$/, ''),
    bucket: (process.env.S3_BUCKET || '').trim(),
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    region: (process.env.S3_REGION || 'auto').trim(),
  },
  // Malware scanning with ClamAV (clamd over TCP). off | optional | required.
  // required (the production default): no scan, no upload.
  scanMode: (process.env.SCAN_MODE || (isProd ? 'required' : 'off')).trim(),
  clamd: {
    host: (process.env.CLAMD_HOST || '').trim(),
    port: Number(process.env.CLAMD_PORT) || 3310,
    timeoutMs: Number(process.env.CLAMD_TIMEOUT_MS) || 15000,
  },
  // Replaced and revoked files are kept this long before the cleanup script may delete them.
  retentionDays: Number(process.env.DOCUMENT_RETENTION_DAYS) || 30,
  // Signs document verification codes (QR). Separate from JWT_SECRET. Optional: without it no
  // verification codes are issued.
  verifyKey: process.env.VERIFY_SIGNING_KEY || '',
};

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}

if (config.mfaKey && config.mfaKey.length < 32) {
  throw new Error('MFA_ENCRYPTION_KEY must be at least 32 characters (or leave it unset to disable MFA)');
}
if (config.publicUrl && !/^https?:\/\/[^\s/?#]+$/.test(config.publicUrl)) {
  throw new Error('PUBLIC_URL must be an origin such as https://example.com (no path, query or spaces)');
}
if (!config.publicUrl && !isProd) config.publicUrl = `http://localhost:${config.port}`;

if (!['local', 's3'].includes(config.storageDriver)) {
  throw new Error('STORAGE_DRIVER must be "local" or "s3"');
}
if (config.storageDriver === 's3') {
  const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].filter((k) => !config.s3[k]);
  if (missing.length) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  if (!/^https?:\/\/[^\s/?#]+$/.test(config.s3.endpoint)) {
    throw new Error('S3_ENDPOINT must be an origin such as https://<account>.r2.cloudflarestorage.com (no path)');
  }
  if (isProd && !config.s3.endpoint.startsWith('https://')) {
    throw new Error('S3_ENDPOINT must use https in production');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.s3.bucket)) {
    throw new Error('S3_BUCKET is not a valid bucket name');
  }
}
if (!['off', 'optional', 'required'].includes(config.scanMode)) {
  throw new Error('SCAN_MODE must be "off", "optional" or "required"');
}
if (config.scanMode !== 'off' && !config.clamd.host) {
  throw new Error(
    'SCAN_MODE=' + config.scanMode + ' needs CLAMD_HOST (a ClamAV daemon). To run without scanning, set SCAN_MODE=off explicitly.'
  );
}
if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1) {
  throw new Error('DOCUMENT_RETENTION_DAYS must be a whole number of days, 1 or more');
}
if (config.verifyKey && config.verifyKey.length < 32) {
  throw new Error('VERIFY_SIGNING_KEY must be at least 32 characters (or leave it unset to disable verification codes)');
}

if (config.signupKey && config.signupKey.length < 16) {
  throw new Error('SIGNUP_KEY must be at least 16 characters (or leave it unset to close signup)');
}

// A connection string can never contain whitespace (it must be %-encoded). Stray spaces
// from copy-and-paste otherwise surface as a confusing "bad auth" error from the database.
if (/\s/.test(config.mongoUri)) {
  throw new Error('MONGODB_URI contains whitespace (spaces, tabs or line breaks); remove them from the connection string');
}

// Production safety checks. They never print the offending values.
// (The example JWT secret in .env.example is shorter than 32 characters, so the
// length rule above already refuses to start with it in every environment.)
if (isProd) {
  if (!config.publicUrl.startsWith('https://')) {
    throw new Error('PUBLIC_URL (https://...) is required in production: it is the base of every invite and reset link');
  }
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is required in production (use your MongoDB Atlas connection string)');
  }
  if (isLocalMongoUri(config.mongoUri)) {
    throw new Error('MONGODB_URI points to a local MongoDB; production must use MongoDB Atlas (mongodb+srv://...)');
  }
}

module.exports = config;
