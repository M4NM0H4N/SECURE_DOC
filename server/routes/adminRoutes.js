'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const { ROLES } = require('../config/constants');
const { createStaffRules, updateUserRules, listUsersRules, auditLogRules } = require('../validators/adminValidators');

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/users', listUsersRules, validate, ctrl.listUsers);
router.post('/users', createStaffRules, validate, ctrl.createUser);
router.patch('/users/:id', updateUserRules, validate, ctrl.updateUser);

// Read-only. There is deliberately no create/update/delete route for audit records.
router.get('/audit-logs', auditLogRules, validate, ctrl.listAuditLogs);

module.exports = router;
