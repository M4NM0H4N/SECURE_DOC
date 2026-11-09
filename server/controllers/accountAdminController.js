'use strict';

const accountService = require('../services/accountService');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

// The link is returned ONCE, to the Admin only, so it can be passed on securely until e-mail
// delivery exists. It is never stored in readable form and never listed again.
const createInvite = asyncHandler(async (req, res) => {
  const { email, role, department, name } = req.body;
  const { invite, link } = await accountService.createInvite(req.user, { email, role, department, name }, req.tenant.slug);
  return ok(res, { invite, link }, 201, 'Invitation created');
});
const listInvites = asyncHandler(async (_req, res) => ok(res, { items: await accountService.listInvites() }));
const resendInvite = asyncHandler(async (req, res) => {
  const { invite, link } = await accountService.resendInvite(req.user, req.params.id, req.tenant.slug);
  return ok(res, { invite, link }, 200, 'New invitation link created; the old one no longer works');
});
const revokeInvite = asyncHandler(async (req, res) => {
  await accountService.revokeInvite(req.user, req.params.id);
  return ok(res, undefined, 200, 'Invitation revoked');
});
const unlock = asyncHandler(async (req, res) => {
  await accountService.unlock(req.user, req.params.id);
  return ok(res, undefined, 200, 'Account unlocked');
});
const signOut = asyncHandler(async (req, res) => {
  await accountService.signOutEverywhere(req.user, req.params.id);
  return ok(res, undefined, 200, 'All sessions ended');
});
const markVerified = asyncHandler(async (req, res) => {
  await accountService.markVerified(req.user, req.params.id);
  return ok(res, undefined, 200, 'E-mail marked as verified');
});
const resetLink = asyncHandler(async (req, res) => {
  const link = await accountService.issueResetLinkForUser(req.user, req.params.id, req.tenant.slug);
  return ok(res, { link }, 200, 'Reset link created. It works once, for one hour.');
});

module.exports = { createInvite, listInvites, resendInvite, revokeInvite, unlock, signOut, markVerified, resetLink };
