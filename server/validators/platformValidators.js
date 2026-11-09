'use strict';

const { body } = require('express-validator');
const { SLUG_PATTERN, RESERVED_SLUGS } = require('../models/Tenant');

const signupRules = [
  body('institutionName')
    .isString().withMessage('Institution name must be text').bail()
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Institution name must be 2-120 characters'),
  body('slug')
    .isString().withMessage('Address must be text').bail()
    .trim()
    .toLowerCase()
    .matches(SLUG_PATTERN).withMessage('Address must be 3-30 characters: lowercase letters, numbers and hyphens').bail()
    .not().isIn(RESERVED_SLUGS).withMessage('That address is reserved'),
  body('adminName')
    .isString().withMessage('Admin name must be text').bail()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Admin name must be 2-100 characters'),
  body('adminEmail')
    .isString().withMessage('Admin email must be text').bail()
    .trim()
    .toLowerCase()
    .isEmail().withMessage('Enter a valid email address')
    .isLength({ max: 254 }).withMessage('Email is too long'),
  body('adminPassword')
    .isString().withMessage('Password must be text').bail()
    .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters')
    .matches(/[A-Za-z]/).withMessage('Password must contain a letter')
    .matches(/\d/).withMessage('Password must contain a number'),
  body('signupKey')
    .isString().withMessage('Signup key is required').bail()
    .isLength({ min: 1, max: 200 }).withMessage('Signup key is required'),
];

module.exports = { signupRules };
