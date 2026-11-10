'use strict';

const requestService = require('../services/requestService');
const { transition, advance, resubmit: resubmitRequest } = require('../services/transitionService');
const { REQUEST_STATUSES } = require('../config/constants');
const documentService = require('../services/documentService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { sendCsv } = require('../utils/csv');
const { ok } = require('../utils/response');

// Only documentType and purpose are read from the body (mass-assignment safe).
const create = asyncHandler(async (req, res) => {
  const { documentType, purpose } = req.body;
  const request = await requestService.createRequest(req.user, { documentType, purpose });
  return ok(res, { request }, 201, 'Request submitted');
});

const listParams = (q) => ({ status: q.status, department: q.department, documentType: q.documentType, q: q.q, from: q.from, to: q.to, sort: q.sort, order: q.order, page: q.page, limit: q.limit });

const list = asyncHandler(async (req, res) => {
  return ok(res, await requestService.listRequests(req.user, listParams(req.query)));
});

// CSV of the same filtered list (the same scope rules apply, so it can only contain what the list shows).
const exportCsv = asyncHandler(async (req, res) => {
  const { header, rows, truncated } = await requestService.exportRequests(req.user, listParams(req.query));
  await auditService.recordSafe({ actorId: req.user._id, action: 'DATA_EXPORTED', details: { kind: 'requests', rows: rows.length } });
  if (truncated) res.setHeader('X-Export-Truncated', 'true');
  sendCsv(res, `requests-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
});

const getOne = asyncHandler(async (req, res) => {
  const request = await requestService.getRequestForUser(req.user, req.params.id);
  return ok(res, { request });
});

// Workflow actions. Only the request id (and rejection reason) come from the client.
const review = asyncHandler(async (req, res) => {
  const request = await transition(req.user, req.params.id, REQUEST_STATUSES.UNDER_REVIEW);
  return ok(res, { request }, 200, "Request moved to review");
});

const approve = asyncHandler(async (req, res) => {
  const request = await transition(req.user, req.params.id, REQUEST_STATUSES.APPROVED);
  return ok(res, { request }, 200, "Request approved");
});

const reject = asyncHandler(async (req, res) => {
  const request = await transition(req.user, req.params.id, REQUEST_STATUSES.REJECTED, { reason: req.body.reason });
  return ok(res, { request }, 200, "Request rejected");
});

// Generic step completion (what the UI calls): the target status follows from the step.
const advanceStep = asyncHandler(async (req, res) => {
  const request = await advance(req.user, req.params.id);
  return ok(res, { request }, 200, 'Step completed');
});

const needsInfo = asyncHandler(async (req, res) => {
  const request = await transition(req.user, req.params.id, REQUEST_STATUSES.NEEDS_INFO, { reason: req.body.note });
  return ok(res, { request }, 200, 'More information requested from the student');
});

const resubmit = asyncHandler(async (req, res) => {
  const request = await resubmitRequest(req.user, req.params.id, { purpose: req.body.purpose });
  return ok(res, { request }, 200, 'Request resubmitted');
});

const uploadDocument = asyncHandler(async (req, res) => {
  const { request, document } = await documentService.uploadFulfilment(req.user, req.params.id, req.file);
  return ok(res, { request, document }, 200, 'Document uploaded and request fulfilled');
});

const addDocument = asyncHandler(async (req, res) => {
  const document = await documentService.addDocument(req.user, req.params.id, req.file);
  return ok(res, { document }, 201, 'Document added');
});

const replaceDocument = asyncHandler(async (req, res) => {
  const document = await documentService.replaceDocument(req.user, req.params.id, req.params.docId, req.file);
  return ok(res, { document }, 200, 'Document replaced by a new version');
});

const revokeDocument = asyncHandler(async (req, res) => {
  const document = await documentService.revokeDocument(req.user, req.params.id, req.params.docId, req.body.reason);
  return ok(res, { document }, 200, 'Document revoked');
});

const listDocuments = asyncHandler(async (req, res) => {
  const items = await documentService.listDocuments(req.user, req.params.id, { slug: req.tenant.slug });
  return ok(res, { items });
});

// Streams the file through the API after every authorisation check; the bucket (or folder) is never exposed.
const sendDocument = (documentId) =>
  asyncHandler(async (req, res) => {
    const doc = await documentService.resolveDownload(req.user, req.params.id, documentId ? req.params.docId : undefined);
    await auditService.recordSafe({ actorId: req.user._id, action: 'DOCUMENT_DOWNLOADED', requestId: doc.requestId, details: { documentId: String(doc.documentId) } });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(doc.mime);
    res.attachment(doc.downloadName);
    if (doc.size) res.setHeader('Content-Length', doc.size);
    doc.stream.on('error', () => res.destroy());
    doc.stream.pipe(res);
  });
const downloadDocument = sendDocument(false);
const downloadDocumentById = sendDocument(true);

module.exports = {
  create, list, exportCsv, getOne, review, approve, reject, advanceStep, needsInfo, resubmit,
  uploadDocument, addDocument, replaceDocument, revokeDocument, listDocuments, downloadDocument, downloadDocumentById,
};
