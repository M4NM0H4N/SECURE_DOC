'use strict';

const path = require('path');
const crypto = require('crypto');

const Request = require('../models/Request');
const Document = require('../models/Document');
const { ROLES, REQUEST_STATUSES } = require('../config/constants');
const { scopeFilter } = require('./requestService');
const { transition } = require('./transitionService');
const { runInTransaction } = require('../config/transactions');
const { getStorage, makeKey } = require('../storage');
const { StorageError } = require('../storage/errors');
const scanner = require('./scanner');
const verification = require('./verificationService');
const audit = require('./auditService');
const AppError = require('../utils/AppError');
const config = require('../config/env');

const MAX_ACTIVE_DOCUMENTS = 10;

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

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const opt = (session) => (session ? { session } : {});

// Never leave a stored object behind when the database step fails.
async function removeQuietly(key) {
  try {
    await getStorage().delete(key);
  } catch (_err) {
    /* the cleanup script removes anything left over */
  }
}

// The upload pipeline shared by fulfilment, extra documents and replacements:
//   1. validate (type by magic bytes, extension matches, size already capped by multer)
//   2. caller's cheap scope/status pre-check (so a refused request never gets scanned)
//   3. malware scan (an infected file is rejected and never stored)
//   4. write to private storage under a tenant-prefixed random key
// Returns what the database step needs. If the database step then fails, the caller removes the file.
async function scanAndStore(actor, request, file, ext) {
  const result = await scanner.scan(file.buffer);
  if (result.status === 'infected') {
    await audit.recordSafe({
      actorId: actor._id,
      action: 'DOCUMENT_REJECTED_INFECTED',
      requestId: request._id,
      details: { signature: result.signature, sizeBytes: file.size },
    });
    throw new AppError(422, 'The file was rejected by the virus scan and was not stored');
  }
  const key = makeKey(request.tenantId, request._id, ext);
  try {
    await getStorage().put(key, file.buffer);
  } catch (_err) {
    throw new AppError(502, 'The document store is not available right now. Nothing was saved.');
  }
  return { key, ext, sizeBytes: file.size, sha256: sha256(file.buffer) };
}

// The clerk's own department, as for every other clerk action. Out of scope = 404.
async function clerkRequest(actor, requestId) {
  const request = await Request.findOne({ _id: requestId, department: actor.department }, 'status tenantId department');
  if (!request) throw new AppError(404, 'Request not found');
  return request;
}

async function assertRoom(requestId) {
  const active = await Document.countDocuments({ requestId, status: 'ACTIVE' });
  if (active >= MAX_ACTIVE_DOCUMENTS) throw new AppError(409, `A request can hold at most ${MAX_ACTIVE_DOCUMENTS} active documents`);
}

/**
 * Clerk uploads the official document for an APPROVED request in their department and the
 * request becomes FULFILLED. The status change, the Document record and the audit records
 * commit together; if that fails for ANY reason the stored file is deleted. A request is
 * never marked FULFILLED unless the file is stored and the database update committed.
 */
async function uploadFulfilment(actor, requestId, file) {
  const ext = validateFile(file);
  const existing = await clerkRequest(actor, requestId);
  if (existing.status !== REQUEST_STATUSES.APPROVED) {
    throw new AppError(409, `Invalid status transition: request is ${existing.status}, expected APPROVED`);
  }
  const stored = await scanAndStore(actor, existing, file, ext);

  let document;
  try {
    const request = await transition(actor, requestId, REQUEST_STATUSES.FULFILLED, {
      extraAudit: [{ action: 'DOCUMENT_UPLOADED', details: { fileType: ext, sizeBytes: file.size } }],
      afterUpdate: async (updated, session) => {
        [document] = await Document.create(
          [{ requestId: updated._id, key: stored.key, fileType: ext, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: actor._id }],
          opt(session)
        );
      },
    });
    return { request, document };
  } catch (err) {
    await removeQuietly(stored.key);
    throw err;
  }
}

// An additional document on a request that is already FULFILLED (for example a certificate plus
// a receipt). A separate endpoint from fulfilment, so two clerks racing to fulfil still get exactly one winner.
async function addDocument(actor, requestId, file) {
  const ext = validateFile(file);
  const existing = await clerkRequest(actor, requestId);
  if (existing.status !== REQUEST_STATUSES.FULFILLED) {
    throw new AppError(409, `Invalid status: request is ${existing.status}, expected FULFILLED (upload the first document to fulfil it)`);
  }
  await assertRoom(existing._id);
  const stored = await scanAndStore(actor, existing, file, ext);
  try {
    return await runInTransaction(async (session) => {
      const [document] = await Document.create(
        [{ requestId: existing._id, key: stored.key, fileType: ext, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: actor._id }],
        opt(session)
      );
      await audit.record(
        { actorId: actor._id, action: 'DOCUMENT_ADDED', requestId: existing._id, details: { documentId: String(document._id), fileType: ext, sizeBytes: file.size } },
        { session }
      );
      return document;
    });
  } catch (err) {
    await removeQuietly(stored.key);
    throw err;
  }
}

// A new version replaces an ACTIVE document. The old record becomes REPLACED (history kept, no
// longer downloadable); the conditional update means two clerks replacing at once cannot both win.
async function replaceDocument(actor, requestId, documentId, file) {
  const ext = validateFile(file);
  const existing = await clerkRequest(actor, requestId);
  if (existing.status !== REQUEST_STATUSES.FULFILLED) throw new AppError(409, `Invalid status: request is ${existing.status}, expected FULFILLED`);
  const old = await Document.findOne({ _id: documentId, requestId: existing._id });
  if (!old) throw new AppError(404, 'Document not found');
  if (old.status !== 'ACTIVE') throw new AppError(409, `Only an active document can be replaced (this one is ${old.status})`);
  const stored = await scanAndStore(actor, existing, file, ext);
  try {
    return await runInTransaction(async (session) => {
      const replaced = await Document.findOneAndUpdate(
        { _id: documentId, requestId: existing._id, status: 'ACTIVE' },
        { $set: { status: 'REPLACED', replacedAt: new Date() } },
        { returnDocument: 'after', ...opt(session) }
      );
      if (!replaced) throw new AppError(409, 'This document was changed by someone else. Reload and try again.');
      const [document] = await Document.create(
        [{ requestId: existing._id, key: stored.key, fileType: ext, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: actor._id, version: old.version + 1, supersedes: old._id }],
        opt(session)
      );
      await audit.record(
        { actorId: actor._id, action: 'DOCUMENT_REPLACED', requestId: existing._id, details: { documentId: String(document._id), replaces: String(old._id), version: document.version } },
        { session }
      );
      return document;
    });
  } catch (err) {
    await removeQuietly(stored.key);
    throw err;
  }
}

// Revoking withdraws an ACTIVE document (issued by mistake, withdrawn certificate). The record and the
// reason stay; the file stops being downloadable and verification reports REVOKED.
async function revokeDocument(actor, requestId, documentId, reason) {
  const existing = await clerkRequest(actor, requestId);
  if (existing.status !== REQUEST_STATUSES.FULFILLED) throw new AppError(409, `Invalid status: request is ${existing.status}, expected FULFILLED`);
  return runInTransaction(async (session) => {
    const revoked = await Document.findOneAndUpdate(
      { _id: documentId, requestId: existing._id, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: new Date(), revokedBy: actor._id, revokedReason: reason } },
      { returnDocument: 'after', ...opt(session) }
    );
    if (!revoked) {
      const any = await Document.findOne({ _id: documentId, requestId: existing._id }, 'status', opt(session));
      if (!any) throw new AppError(404, 'Document not found');
      throw new AppError(409, `Only an active document can be revoked (this one is ${any.status})`);
    }
    // The reason is stored on the document; the audit entry only names the document (no free text).
    await audit.record({ actorId: actor._id, action: 'DOCUMENT_REVOKED', requestId: existing._id, details: { documentId: String(revoked._id) } }, { session });
    return revoked;
  });
}

// Admin and Principal never see document contents or even which documents exist.
function assertMayAccess(user) {
  if (user.role === ROLES.ADMIN || user.role === ROLES.PRINCIPAL) throw new AppError(403, 'Access denied');
}

// Students see their own active documents; staff of the department also see the history.
async function listDocuments(user, requestId, { slug } = {}) {
  assertMayAccess(user);
  const request = await Request.findOne({ _id: requestId, ...scopeFilter(user) }, 'status');
  if (!request) throw new AppError(404, 'Request not found');
  const student = user.role === ROLES.STUDENT;
  const docs = await Document.find(student ? { requestId, status: 'ACTIVE' } : { requestId })
    .select('+sha256')
    .sort({ createdAt: 1 });
  const base = verification.available() && slug ? `${config.publicUrl}/t/${slug}/verify.html?code=` : null;
  return docs.map((d) => {
    const out = {
      _id: d._id, version: d.version, fileType: d.fileType, sizeBytes: d.sizeBytes, status: d.status,
      createdAt: d.createdAt, supersedes: d.supersedes,
    };
    if (!student) {
      out.revokedAt = d.revokedAt;
      out.revokedReason = d.revokedReason;
    }
    if (d.status === 'ACTIVE' && base) out.verifyUrl = base + verification.codeFor(d);
    return out;
  });
}

/**
 * Resolves a download for the current user. Students: own requests only. Clerk/HOD: own
 * department only. Admin and Principal: no access to document contents. Only ACTIVE documents
 * can be downloaded. Without a document id the newest active one is served.
 */
async function resolveDownload(user, requestId, documentId) {
  assertMayAccess(user);

  const request = await Request.findOne({ _id: requestId, ...scopeFilter(user) }, 'documentType status tenantId');
  if (!request) throw new AppError(404, 'Request not found');
  if (request.status !== REQUEST_STATUSES.FULFILLED) throw new AppError(409, 'The document is not available yet');

  const filter = { requestId: request._id, status: 'ACTIVE', ...(documentId ? { _id: documentId } : {}) };
  const document = await Document.findOne(filter).select('+key').sort({ createdAt: -1 });
  if (!document) {
    if (documentId) throw new AppError(404, 'Document not found');
    throw new AppError(409, 'The document is not available yet');
  }
  // Defence in depth: the key must belong to this institution and this request.
  if (!document.key.startsWith(`${request.tenantId}/${request._id}/`)) throw new AppError(500, 'Stored document reference is invalid');

  let file;
  try {
    file = await getStorage().get(document.key);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'NOT_FOUND') throw new AppError(404, 'Document file is missing');
    if (err instanceof StorageError && err.code === 'INVALID_KEY') throw new AppError(500, 'Stored document reference is invalid');
    throw new AppError(502, 'The document store is not available right now');
  }

  const total = await Document.countDocuments({ requestId: request._id });
  const safeType = request.documentType.replace(/[^A-Za-z0-9]+/g, '_');
  // A request with a single document keeps the plain name; several get a version and id suffix.
  const suffix = total > 1 ? `_v${document.version}_${String(document._id).slice(-6)}` : '';
  return {
    requestId: request._id,
    documentId: document._id,
    stream: file.stream,
    size: file.size,
    mime: MIME_BY_EXT[document.fileType],
    downloadName: `${safeType}_${request._id}${suffix}.${document.fileType}`,
  };
}

module.exports = {
  uploadFulfilment, addDocument, replaceDocument, revokeDocument, listDocuments, resolveDownload,
  validateFile, detectType, MAX_ACTIVE_DOCUMENTS,
};
