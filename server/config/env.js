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
  cookieMaxAgeMs: 2 * 60 * 60 * 1000,
  // Private storage, outside client/ (never served statically).
  uploadDir: path.resolve(__dirname, '..', '..', process.env.UPLOAD_DIR || 'server/uploads'),
  uploadDirIsDefault: !process.env.UPLOAD_DIR,
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024,
};

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
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
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is required in production (use your MongoDB Atlas connection string)');
  }
  if (isLocalMongoUri(config.mongoUri)) {
    throw new Error('MONGODB_URI points to a local MongoDB; production must use MongoDB Atlas (mongodb+srv://...)');
  }
}

module.exports = config;
