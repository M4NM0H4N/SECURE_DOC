'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const Document = require('../models/Document');
const Request = require('../models/Request');
const AppError = require('../utils/AppError');

// A verification code proves that a document was issued by this institution through this system
// and has not been revoked, without exposing the file or any personal data.
//
//   code = <documentId>-<signature>
//   signature = first 24 bytes of HMAC-SHA256(VERIFY_SIGNING_KEY,
//                 tenantId | requestId | documentId | sha256-of-the-file), base64url
//
// The signature covers the file's hash, so a stored hash that is later altered no longer
// verifies. The key is separate from JWT_SECRET. Lookups run inside the institution's tenant
// context, so a code only ever works under its own institution's address.
const CODE_FORMAT = /^[0-9a-f]{24}-[A-Za-z0-9_-]{32}$/;

const available = () => Boolean(config.verifyKey);

function signature(doc) {
  const data = [doc.tenantId, doc.requestId, doc._id, doc.sha256].map(String).join('|');
  return crypto.createHmac('sha256', config.verifyKey).update(data).digest().subarray(0, 24).toString('base64url');
}

// `doc` must have been loaded with +sha256.
const codeFor = (doc) => `${doc._id}-${signature(doc)}`;

const NOT_FOUND = () => new AppError(404, 'No document matches this code');

async function lookup(code) {
  if (!available()) throw new AppError(503, 'Document verification is not enabled for this installation');
  if (typeof code !== 'string' || !CODE_FORMAT.test(code)) throw NOT_FOUND();
  // The signature itself may contain '-', so split at the fixed position, not on every dash.
  const id = code.slice(0, 24);
  const sig = code.slice(25);
  const doc = await Document.findOne({ _id: id }).select('+sha256');
  if (!doc) throw NOT_FOUND();
  const expected = Buffer.from(signature(doc));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw NOT_FOUND();
  return doc;
}

const STATUS_WORDS = { ACTIVE: 'VALID', REPLACED: 'SUPERSEDED', REVOKED: 'REVOKED' };

// What anyone holding the code may learn: the institution (added by the caller), the kind of
// document, when it was issued and whether it is still valid. Nothing about the holder.
async function describe(code) {
  const doc = await lookup(code);
  const request = await Request.findOne({ _id: doc.requestId }, 'documentType');
  return {
    status: STATUS_WORDS[doc.status],
    valid: doc.status === 'ACTIVE',
    documentType: request ? request.documentType : null,
    issuedAt: doc.createdAt,
    version: doc.version,
  };
}

// The browser hashes a file the verifier holds and sends only the hash, so the file never
// leaves their computer and the stored hash is never revealed. Answers yes or no.
async function checkHash(code, sha256) {
  const doc = await lookup(code);
  const given = Buffer.from(String(sha256).toLowerCase(), 'hex');
  const stored = Buffer.from(doc.sha256, 'hex');
  const matches = given.length === stored.length && crypto.timingSafeEqual(given, stored);
  return { matches, status: STATUS_WORDS[doc.status], valid: doc.status === 'ACTIVE' };
}

module.exports = { available, codeFor, describe, checkHash, CODE_FORMAT };
