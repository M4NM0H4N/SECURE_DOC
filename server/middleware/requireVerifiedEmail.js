'use strict';

const config = require('../config/env');
const AppError = require('../utils/AppError');

// When REQUIRE_EMAIL_VERIFICATION is on, a student must confirm their address before
// submitting requests. (Off by default until e-mail delivery exists; see docs/ACCOUNTS.md.)
function requireVerifiedEmail(req, _res, next) {
  if (config.requireEmailVerification && !req.user.emailVerifiedAt) {
    return next(new AppError(403, 'Please verify your e-mail address before submitting a request'));
  }
  next();
}

module.exports = requireVerifiedEmail;
