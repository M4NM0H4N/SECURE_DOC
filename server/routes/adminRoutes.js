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
const { inviteRules, userIdRule, inviteIdRule } = require('../validators/accountValidators');
const { updateUserRules, listUsersRules, auditLogRules } = require('../validators/adminValidators');

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/users', listUsersRules, validate, ctrl.listUsers);
router.patch('/users/:id', updateUserRules, validate, ctrl.updateUser);

// Staff onboarding and account recovery (S3). There is no route that sets someone's password.
router.get('/invites', acct.listInvites);
router.post('/invites', inviteRules, validate, acct.createInvite);
router.post('/invites/:id/resend', inviteIdRule, validate, acct.resendInvite);
router.delete('/invites/:id', inviteIdRule, validate, acct.revokeInvite);
router.post('/users/:id/unlock', userIdRule, validate, acct.unlock);
router.post('/users/:id/sign-out', userIdRule, validate, acct.signOut);
router.post('/users/:id/verify-email', userIdRule, validate, acct.markVerified);
router.post('/users/:id/reset-link', userIdRule, validate, acct.resetLink);

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
router.get('/audit-logs', auditLogRules, validate, ctrl.listAuditLogs);

module.exports = router;
