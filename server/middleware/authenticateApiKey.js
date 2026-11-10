'use strict';

const apiKeys = require('../services/apiKeyService');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// Bearer API key for ONE institution (the tenant in the URL). A key of another institution, a wrong,
// expired or revoked key and a malformed header all answer the same 401.
module.exports = (scope) =>
  asyncHandler(async (req, _res, next) => {
    const key = await apiKeys.authenticate(req.get('authorization'));
    if (!key) throw new AppError(401, 'Invalid or missing API key');
    if (!key.scopes.includes(scope)) throw new AppError(403, `This API key does not have the "${scope}" scope`);
    req.apiKey = key;
    next();
  });
