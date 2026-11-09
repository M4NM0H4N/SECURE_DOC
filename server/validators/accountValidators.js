'use strict';

const { body, param, query } = require('express-validator');
const { STAFF_ROLES } = require('../config/constants');
const { email, name } = require('./authValidators');

// Same rule as registration, under any field name.
const password = (field) =>
  body(field)
    .isString().withMessage('Password must be text').bail()
    .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters')
    .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
    .matches(/\d/).withMessage('Password must contain a number');

const token = (where) =>
  where('token')
    .isString().withMessage('This link is invalid or has expired').bail()
    .matches(/^[A-Za-z0-9_-]{43}$/).withMessage('This link is invalid or has expired');

const code = body('code')
  .isString().withMessage('Enter your authentication code').bail()
  .trim()
  .isLength({ min: 6, max: 11 }).withMessage('Enter your authentication code');

const changePasswordRules = [
  body('currentPassword').isString().withMessage('Enter your current password').bail().isLength({ min: 1, max: 72 }).withMessage('Enter your current password'),
  password('newPassword'),
];
const forgotPasswordRules = [email];
const resetPasswordRules = [token(body), password('password')];
const verifyEmailRules = [token(body)];
const peekInviteRules = [token(query)];
const acceptInviteRules = [token(body), name, password('password')];
const mfaLoginRules = [
  body('challenge').isString().withMessage('Start the sign-in again').bail().isLength({ min: 20, max: 2000 }).withMessage('Start the sign-in again'),
  code,
];
const mfaEnableRules = [code];
const mfaDisableRules = [body('password').isString().withMessage('Enter your password').bail().isLength({ min: 1, max: 72 }).withMessage('Enter your password'), code];

const { departmentCheck } = require('./authValidators');
const inviteRules = [
  email,
  body('name').optional({ values: 'falsy' }).isString().withMessage('Name must be text').bail().trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('role').isString().withMessage('Role must be text').bail().isIn(STAFF_ROLES).withMessage(`Role must be one of: ${STAFF_ROLES.join(', ')}`),
  // A Principal is institution-wide and has no department; everyone else needs one.
  departmentCheck(body('department').if(body('role').not().equals('PRINCIPAL'))),
];
const userIdRule = [param('id').isMongoId().withMessage('Invalid user id')];
const inviteIdRule = [param('id').isMongoId().withMessage('Invalid invitation id')];

module.exports = {
  changePasswordRules, forgotPasswordRules, resetPasswordRules, verifyEmailRules, peekInviteRules,
  acceptInviteRules, mfaLoginRules, mfaEnableRules, mfaDisableRules, inviteRules, userIdRule, inviteIdRule,
};
