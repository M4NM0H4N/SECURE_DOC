'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/authController');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const { registerRules, loginRules } = require('../validators/authValidators');
const v = require('../validators/accountValidators');

router.post('/register', registerRules, validate, ctrl.register);
router.post('/login', loginRules, validate, ctrl.login);
router.post('/login/mfa', v.mfaLoginRules, validate, ctrl.loginMfa);
router.post('/logout', authenticate, ctrl.logout);
router.get('/me', authenticate, ctrl.me);

router.post('/change-password', authenticate, v.changePasswordRules, validate, ctrl.changePassword);
router.post('/forgot-password', v.forgotPasswordRules, validate, ctrl.forgotPassword);
router.post('/reset-password', v.resetPasswordRules, validate, ctrl.resetPassword);
router.post('/verify-email', v.verifyEmailRules, validate, ctrl.verifyEmail);
router.post('/resend-verification', authenticate, ctrl.resendVerification);

router.get('/invite', v.peekInviteRules, validate, ctrl.peekInvite);
router.post('/accept-invite', v.acceptInviteRules, validate, ctrl.acceptInvite);

router.post('/mfa/setup', authenticate, ctrl.mfaSetup);
router.post('/mfa/enable', authenticate, v.mfaEnableRules, validate, ctrl.mfaEnable);
router.post('/mfa/disable', authenticate, v.mfaDisableRules, validate, ctrl.mfaDisable);

module.exports = router;
