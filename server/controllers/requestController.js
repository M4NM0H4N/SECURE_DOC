'use strict';

const requestService = require('../services/requestService');
const { transition } = require('../services/transitionService');
const { REQUEST_STATUSES } = require('../config/constants');
const documentService = require('../services/documentService');
const auditService = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

// Only documentType and purpose are read from the body (mass-assignment safe).
const create = asyncHandler(async (req, res) => {
  const { documentType, purpose } = req.body;
  const request = await requestService.createRequest(req.user, { documentType, purpose });
  return ok(res, { request }, 201, 'Request submitted');
});

const list = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  return ok(res, await requestService.listRequests(req.user, { status, page, limit }));
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

const uploadDocument = asyncHandler(async (req, res) => {
  const request = await documentService.uploadFulfilment(req.user, req.params.id, req.file);
  return ok(res, { request }, 200, 'Document uploaded and request fulfilled');
});

const downloadDocument = asyncHandler(async (req, res) => {
  const doc = await documentService.resolveDownload(req.user, req.params.id);
  await auditService.recordSafe({ actorId: req.user._id, action: 'DOCUMENT_DOWNLOADED', requestId: doc.requestId });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(doc.mime);
  res.attachment(doc.downloadName);
  res.sendFile(doc.fullPath, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: 'Document file is missing' });
  });
});

module.exports = { create, list, getOne, review, approve, reject, uploadDocument, downloadDocument };
