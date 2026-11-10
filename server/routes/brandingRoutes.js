'use strict';

// Public: the sign-in page asks for the institution's name, colour and logo before anyone is signed in.
const router = require('express').Router();
const branding = require('../services/brandingService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

router.get('/', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, await branding.publicBranding(req.tenant));
}));

router.get('/logo', asyncHandler(async (req, res) => {
  const logo = await branding.getLogo(req.tenant);
  res.set({
    'Content-Type': logo.type === 'png' ? 'image/png' : 'image/jpeg',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.send(logo.data);
}));

module.exports = router;
