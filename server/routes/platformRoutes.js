'use strict';

// Platform-level routes (no tenant in the path): institution signup and the SUPER_ADMIN.
const router = require('express').Router();
const ctrl = require('../controllers/platformController');
const authenticatePlatform = require('../middleware/authenticatePlatform');
const validate = require('../middleware/validate');
const { signupRules } = require('../validators/platformValidators');
const { loginRules } = require('../validators/authValidators');

router.post('/signup', signupRules, validate, ctrl.signup);
router.post('/auth/login', loginRules, validate, ctrl.login);
router.post('/auth/logout', authenticatePlatform, ctrl.logout);
router.get('/tenants', authenticatePlatform, ctrl.tenants);

module.exports = router;
