'use strict';

const Tenant = require('../models/Tenant');
const { SLUG_PATTERN } = require('../models/Tenant');
const { runAsTenant } = require('../utils/tenantContext');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// The one place a request's tenant is decided: from the /t/:slug/ path segment.
// Unknown, malformed and suspended institutions all answer the same 404, so the
// response never reveals which slugs exist. Everything after this runs inside the
// tenant context, which the tenantScope plugin reads for every query.
const resolveTenant = asyncHandler(async (req, _res, next) => {
  const slug = String(req.params.slug || '');
  if (!SLUG_PATTERN.test(slug)) throw new AppError(404, 'Institution not found');
  const tenant = await Tenant.findOne({ slug, status: 'ACTIVE' });
  if (!tenant) throw new AppError(404, 'Institution not found');
  req.tenant = tenant;
  runAsTenant(tenant._id, next);
});

module.exports = resolveTenant;
