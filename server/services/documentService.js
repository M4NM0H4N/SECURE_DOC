'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config/env');
const Request = require('../models/Request');
const { ROLES, REQUEST_STATUSES } = require('../config/constants');
const { scopeFilter } = require('./requestService');
const { transition } = require('./transitionService');
const AppError = require('../utils/AppError');

// Our own signature check for the only three formats we accept. We read raw
// magic bytes ourselves instead of trusting the browser MIME type or extension.
const SIGNATURES = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
const EXT_ALIASES = { pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const MIME_BY_EXT = Object.fromEntries(SIGNATURES.map((s) => [s.ext, s.mime]));
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg)$/;

function detectType(buffer) {
  const hit = SIGNATURES.find((s) => s.test(buffer));
  return hit ? hit.ext : null;
}

function validateFile(file) {
  if (!file || !file.buffer || file.size === 0) {
    throw new AppError(400, 'A document file is required (multipart field "document")');
  }
  const detected = detectType(file.buffer);
  if (!detected) {
    throw new AppError(400, 'Only PDF, JPG and PNG files are allowed (file content was not recognised)');
  }
  const claimed = EXT_ALIASES[path.extname(file.originalname || '').slice(1).toLowerCase()];
  if (claimed !== detected) {
    throw new AppError(400, 'File extension does not match the file content');
  }
  return detected;
}

async function removeQuietly(fullPath) {
  try {
    await fs.promises.unlink(fullPath);
  } catch (_err) {
    /* already gone */
  }
}

/**
 * Clerk uploads the official document for an APPROVED request in their department.
 * Order matters for safe cleanup:
 *   1. validate the file (type, signature, size already capped by multer)
 *   2. cheap pre-check of scope and status for clean errors
 *   3. write the file under a random UUID name in private storage
 *   4. atomically move APPROVED -> FULFILLED and write the audit records
 *   5. if step 4 fails for ANY reason, delete the file. The request is never
 *      marked FULFILLED unless the file is stored and the DB update committed.
 */
async function uploadFulfilment(actor, requestId, file) {
  const ext = validateFile(file);

  const existing = await Request.findOne({ _id: requestId, department: actor.department }, 'status');
  if (!existing) throw new AppError(404, 'Request not found');
  if (existing.status !== REQUEST_STATUSES.APPROVED) {
    throw new AppError(409, `Invalid status transition: request is ${existing.status}, expected APPROVED`);
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  const fullPath = path.join(config.uploadDir, filename);
  await fs.promises.mkdir(config.uploadDir, { recursive: true });
  await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o600 });

  try {
    return await transition(actor, requestId, REQUEST_STATUSES.FULFILLED, {
      extraSet: { documentPath: filename },
      extraAudit: [{ action: 'DOCUMENT_UPLOADED', details: { fileType: ext, sizeBytes: file.size } }],
    });
  } catch (err) {
    await removeQuietly(fullPath);
    throw err;
  }
}

/**
 * Resolves a download for the current user. Students: own requests only.
 * Clerk/HOD: own department only. Admin: no access to document contents.
 */
async function resolveDownload(user, requestId) {
  if (user.role === ROLES.ADMIN) throw new AppError(403, 'Access denied');

  const request = await Request.findOne({ _id: requestId, ...scopeFilter(user) }).select('+documentPath documentType status');
  if (!request) throw new AppError(404, 'Request not found');
  if (request.status !== REQUEST_STATUSES.FULFILLED || !request.documentPath) {
    throw new AppError(409, 'The document is not available yet');
  }

  const name = request.documentPath;
  if (!STORED_NAME.test(name)) throw new AppError(500, 'Stored document reference is invalid');
  const fullPath = path.resolve(config.uploadDir, name);
  if (!fullPath.startsWith(path.resolve(config.uploadDir) + path.sep)) {
    throw new AppError(500, 'Stored document reference is invalid');
  }

  try {
    await fs.promises.access(fullPath, fs.constants.R_OK);
  } catch (_err) {
    throw new AppError(404, 'Document file is missing');
  }

  const ext = name.split('.').pop();
  const safeType = request.documentType.replace(/[^A-Za-z0-9]+/g, '_');
  return {
    requestId: request._id,
    fullPath,
    mime: MIME_BY_EXT[ext],
    downloadName: `${safeType}_${request._id}.${ext}`,
  };
}

module.exports = { uploadFulfilment, resolveDownload, validateFile, detectType };
