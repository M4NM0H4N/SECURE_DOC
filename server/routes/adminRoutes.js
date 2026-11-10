'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const { ROLES } = require('../config/constants');
const cfg = require('../controllers/configController');
const v = require('../validators/configValidators');
const acct = require('../controllers/accountAdminController');
const { query, param, body } = require('express-validator');
const branding = require('../services/brandingService');
const auditService = require('../services/auditService');
const uploadLogo = require('../middleware/uploadLogo');
const notifications = require('../services/notificationService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');
const { inviteRules, userIdRule, inviteIdRule } = require('../validators/accountValidators');
const { updateUserRules, listUsersRules, auditLogRules } = require('../validators/adminValidators');

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/users', listUsersRules, validate, ctrl.listUsers);
router.get('/users/export.csv', listUsersRules, validate, ctrl.exportUsers);
router.patch('/users/:id', updateUserRules, validate, ctrl.updateUser);

// E-mail delivery log and manual retry (S5). Never shows message content or links.
router.get(
  '/notifications',
  query('status').optional().isIn(['PENDING', 'SENT', 'FAILED', 'CANCELLED']).withMessage('Invalid status'),
  query('type').optional().isString().isLength({ max: 40 }).withMessage('Invalid type'),
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit').toInt(),
  validate,
  asyncHandler(async (req, res) => ok(res, await notifications.listDeliveries(req.query)))
);
router.post(
  '/notifications/:id/retry',
  param('id').isMongoId().withMessage('Invalid id'),
  validate,
  asyncHandler(async (req, res) => {
    await notifications.retry(req.user, req.params.id);
    return ok(res, undefined, 200, 'Queued for another attempt');
  })
);

// Staff onboarding and account recovery (S3). There is no route that sets someone's password.
router.get('/invites', acct.listInvites);
router.post('/invites', inviteRules, validate, acct.createInvite);
router.post('/invites/:id/resend', inviteIdRule, validate, acct.resendInvite);
router.delete('/invites/:id', inviteIdRule, validate, acct.revokeInvite);
router.post('/users/:id/unlock', userIdRule, validate, acct.unlock);
router.post('/users/:id/sign-out', userIdRule, validate, acct.signOut);
router.post('/users/:id/verify-email', userIdRule, validate, acct.markVerified);
router.post('/users/:id/reset-link', userIdRule, validate, acct.resetLink);

router.use(require('./integrationAdminRoutes'));

// Branding (S7).
router.put(
  '/branding',
  body('color').optional({ values: 'null' }).isString().withMessage('Colour must be text').bail().isLength({ max: 7 }),
  body('tagline').optional({ values: 'null' }).isString().withMessage('Tagline must be text').bail().trim().isLength({ max: 120 }).withMessage('Tagline is too long (120 characters)'),
  validate,
  asyncHandler(async (req, res) => {
    const out = await branding.setBranding(req.tenant, { color: req.body.color, tagline: req.body.tagline });
    await auditService.recordSafe({ actorId: req.user._id, action: 'BRANDING_UPDATED', details: { what: 'colour and tagline' } });
    return ok(res, out, 200, 'Branding saved');
  })
);
router.post('/branding/logo', uploadLogo, asyncHandler(async (req, res) => {
  const out = await branding.setLogo(req.tenant, req.file);
  await auditService.recordSafe({ actorId: req.user._id, action: 'BRANDING_UPDATED', details: { what: 'logo added' } });
  return ok(res, out, 200, 'Logo saved');
}));
router.delete('/branding/logo', asyncHandler(async (req, res) => {
  const out = await branding.removeLogo(req.tenant);
  await auditService.recordSafe({ actorId: req.user._id, action: 'BRANDING_UPDATED', details: { what: 'logo removed' } });
  return ok(res, out, 200, 'Logo removed');
}));

// Institution configuration (S2): departments, document types and the approval chain.
router.get('/departments', cfg.listDepartments);
router.post('/departments', v.createDepartmentRules, validate, cfg.createDepartment);
router.patch('/departments/:id', v.updateDepartmentRules, validate, cfg.updateDepartment);
router.get('/document-types', cfg.listDocumentTypes);
router.post('/document-types', v.createDocumentTypeRules, validate, cfg.createDocumentType);
router.patch('/document-types/:id', v.updateDocumentTypeRules, validate, cfg.updateDocumentType);
router.get('/workflow', cfg.getWorkflow);
router.put('/workflow', v.workflowRules, validate, cfg.putWorkflow);

// Read-only. There is deliberately no create/update/delete route for audit records.
router.get('/data-export', ctrl.exportInstitutionData);
router.get('/audit-logs', auditLogRules, validate, ctrl.listAuditLogs);
router.get('/audit-logs/export.csv', auditLogRules, validate, ctrl.exportAuditLogs);
router.get('/audit-logs/verify', ctrl.verifyAuditChain);

module.exports = router;
