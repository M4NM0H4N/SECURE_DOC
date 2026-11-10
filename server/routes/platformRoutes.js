'use strict';

// Platform-level routes (no tenant in the path): institution signup and the SUPER_ADMIN.
const router = require('express').Router();
const ctrl = require('../controllers/platformController');
const authenticatePlatform = require('../middleware/authenticatePlatform');
const validate = require('../middleware/validate');
const { signupRules } = require('../validators/platformValidators');
const { loginRules } = require('../validators/authValidators');
const { param, body } = require('express-validator');
const { SLUG_PATTERN } = require('../models/Tenant');

const slugRule = [param('slug').matches(SLUG_PATTERN).withMessage('Invalid institution address')];
const deleteRules = [body('confirm').isString().withMessage('confirm is required')];

router.post('/signup', signupRules, validate, ctrl.signup);
router.post('/auth/login', loginRules, validate, ctrl.login);
router.post('/auth/logout', authenticatePlatform, ctrl.logout);
router.get('/tenants', authenticatePlatform, ctrl.tenants);
router.post('/tenants/:slug/suspend', authenticatePlatform, slugRule, validate, ctrl.suspend);
router.post('/tenants/:slug/resume', authenticatePlatform, slugRule, validate, ctrl.resume);
// Irreversible: needs the institution suspended and its address typed back in the body.
router.delete('/tenants/:slug', authenticatePlatform, slugRule, deleteRules, validate, ctrl.remove);

module.exports = router;
