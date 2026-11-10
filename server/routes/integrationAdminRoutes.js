'use strict';

// Admin management of API keys and webhooks (mounted under /admin, which already requires the Admin role).
const router = require('express').Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const apiKeys = require('../services/apiKeyService');
const webhooks = require('../services/webhookService');
const { API_SCOPES } = require('../models/ApiKey');
const { WEBHOOK_EVENTS } = require('../models/Webhook');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const id = param('id').isMongoId().withMessage('Invalid id');
const name = (c) => c.isString().withMessage('Name must be text').bail().trim().isLength({ min: 2, max: 60 }).withMessage('Name must be 2-60 characters');

// ---- API keys
router.get('/api-keys', asyncHandler(async (_req, res) => ok(res, { items: await apiKeys.list(), scopes: API_SCOPES })));
router.post(
  '/api-keys',
  name(body('name')),
  body('scopes').isArray({ min: 1, max: API_SCOPES.length }).withMessage('scopes must be a list'),
  body('expiresInDays').optional({ values: 'null' }).isInt({ min: 1, max: 730 }).withMessage('expiresInDays must be 1-730').toInt(),
  validate,
  asyncHandler(async (req, res) => {
    const { key, secret } = await apiKeys.create(req.user, { name: req.body.name, scopes: req.body.scopes, expiresInDays: req.body.expiresInDays });
    return ok(res, { key, secret }, 201, 'API key created. Copy it now: it is shown only once.');
  })
);
router.delete('/api-keys/:id', id, validate, asyncHandler(async (req, res) => {
  await apiKeys.revoke(req.user, req.params.id);
  return ok(res, undefined, 200, 'API key revoked');
}));

// ---- webhooks
const events = body('events').isArray({ min: 1, max: WEBHOOK_EVENTS.length }).withMessage('events must be a list');
router.get('/webhooks', asyncHandler(async (_req, res) => ok(res, { items: await webhooks.list(), events: WEBHOOK_EVENTS.filter((e) => e !== 'ping'), available: webhooks.available() })));
router.post(
  '/webhooks',
  name(body('name')),
  body('url').isString().withMessage('url must be text').bail().isLength({ min: 8, max: 500 }).withMessage('url is too long or too short'),
  events,
  validate,
  asyncHandler(async (req, res) => {
    const { hook, secret } = await webhooks.create(req.user, { name: req.body.name, url: req.body.url, events: req.body.events });
    return ok(res, { webhook: hook, secret }, 201, 'Webhook created. Copy the signing secret now: it is shown only once.');
  })
);
router.patch(
  '/webhooks/:id',
  id,
  name(body('name').optional()),
  body('url').optional().isString().isLength({ min: 8, max: 500 }),
  body('events').optional().isArray({ min: 1, max: WEBHOOK_EVENTS.length }),
  body('active').optional().isBoolean({ strict: true }).withMessage('active must be true or false'),
  validate,
  asyncHandler(async (req, res) => ok(res, { webhook: await webhooks.update(req.user, req.params.id, { name: req.body.name, url: req.body.url, events: req.body.events, active: req.body.active }) }, 200, 'Webhook updated'))
);
router.delete('/webhooks/:id', id, validate, asyncHandler(async (req, res) => {
  await webhooks.remove(req.user, req.params.id);
  return ok(res, undefined, 200, 'Webhook deleted');
}));
router.post('/webhooks/:id/rotate-secret', id, validate, asyncHandler(async (req, res) => ok(res, { secret: await webhooks.rotateSecret(req.user, req.params.id) }, 200, 'New signing secret. Copy it now: it is shown only once.')));
router.post('/webhooks/:id/ping', id, validate, asyncHandler(async (req, res) => {
  await webhooks.ping(req.user, req.params.id);
  return ok(res, undefined, 200, 'Test event queued');
}));
router.get(
  '/webhooks/:id/deliveries', id,
  query('page').optional().isInt({ min: 1, max: 10000 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  validate,
  asyncHandler(async (req, res) => ok(res, await webhooks.deliveries(req.params.id, { page: req.query.page, limit: req.query.limit })))
);

module.exports = router;
