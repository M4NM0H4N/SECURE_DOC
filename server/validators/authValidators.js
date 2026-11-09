'use strict';

const { body } = require('express-validator');
const configService = require('../services/configService');

const name = body('name')
  .isString().withMessage('Name must be text').bail()
  .trim()
  .isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters');

const email = body('email')
  .isString().withMessage('Email must be text').bail()
  .trim()
  .toLowerCase()
  .isEmail().withMessage('Enter a valid email address')
  .isLength({ max: 254 }).withMessage('Email is too long');

// bcrypt only uses the first 72 bytes, so cap the length.
const newPassword = body('password')
  .isString().withMessage('Password must be text').bail()
  .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters')
  .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
  .matches(/\d/).withMessage('Password must contain a number');

// Checked against the institution's own active departments (runs inside the tenant context).
const departmentCheck = (chain) =>
  chain
    .isString().withMessage('Department must be text').bail()
    .trim()
    .toUpperCase()
    .custom(async (v) => {
      if (!(await configService.isActiveDepartment(v))) throw new Error('Choose one of this institution\'s departments');
      return true;
    });

const department = departmentCheck(body('department'));

const registerRules = [name, email, newPassword, department];

const loginRules = [
  email,
  body('password')
    .isString().withMessage('Password must be text').bail()
    .notEmpty().withMessage('Password is required')
    .isLength({ max: 72 }).withMessage('Password is too long'),
];

module.exports = { name, email, newPassword, department, departmentCheck, registerRules, loginRules };
