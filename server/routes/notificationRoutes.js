'use strict';

// A person's own in-app notifications and e-mail preference. Every query is for the signed-in user
// inside their own institution, so there is no way to read someone else's.
const router = require('express').Router();
const { body, param, query } = require('express-validator');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const service = require('../services/notificationService');
const mailer = require('../services/mailer');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

router.use(authenticate);

router.get(
  '/',
  query('unread').optional().isBoolean().withMessage('unread must be true or false').toBoolean(),
  query('page').optional().isInt({ min: 1, max: 10000 }).withMessage('Invalid page').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit').toInt(),
  validate,
  asyncHandler(async (req, res) => {
    const { unread, page, limit } = req.query;
    res.set('Cache-Control', 'no-store');
    return ok(res, await service.listMine(req.user, { unread, page, limit }));
  })
);

router.post('/read-all', asyncHandler(async (req, res) => {
  await service.markAllRead(req.user);
  return ok(res, undefined, 200, 'All notifications marked as read');
}));

router.get('/preferences', (req, res) => ok(res, { email: req.user.notifyEmail !== false, mailAvailable: mailer.enabled() }));
router.patch(
  '/preferences',
  body('email').isBoolean({ strict: true }).withMessage('email must be true or false'),
  validate,
  asyncHandler(async (req, res) => {
    await service.setPreferences(req.user, { email: req.body.email });
    return ok(res, { email: req.body.email }, 200, 'Preference saved');
  })
);

router.post(
  '/:id/read',
  param('id').isMongoId().withMessage('Invalid id'),
  validate,
  asyncHandler(async (req, res) => {
    await service.markRead(req.user, req.params.id);
    return ok(res, undefined, 200, 'Marked as read');
  })
);

module.exports = router;
