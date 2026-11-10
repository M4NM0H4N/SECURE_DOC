'use strict';

// Public: anyone holding a document's verification code (from its QR) can check that it is
// genuine and still valid. Nothing about the holder of the document is ever returned.
const router = require('express').Router();
const { body, param } = require('express-validator');
const verification = require('../services/verificationService');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const codeRule = param('code').isString().isLength({ min: 10, max: 80 }).withMessage('Invalid code');

router.get(
  '/:code',
  codeRule,
  validate,
  asyncHandler(async (req, res) => {
    const info = await verification.describe(req.params.code);
    res.set('Cache-Control', 'no-store');
    return ok(res, { institution: req.tenant.name, ...info });
  })
);

// The browser hashes a file locally and sends only the hash. Answers whether it is this document.
router.post(
  '/:code/check',
  codeRule,
  body('sha256').isString().matches(/^[0-9a-fA-F]{64}$/).withMessage('sha256 must be 64 hex characters'),
  validate,
  asyncHandler(async (req, res) => {
    const result = await verification.checkHash(req.params.code, req.body.sha256);
    res.set('Cache-Control', 'no-store');
    return ok(res, { institution: req.tenant.name, ...result });
  })
);

module.exports = router;
