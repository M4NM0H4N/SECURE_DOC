'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/requestController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const uploadSingle = require('../middleware/upload');
const { ROLES } = require('../config/constants');
const { createRequestRules, requestIdRule, listRequestsRules, rejectRules } = require('../validators/requestValidators');

router.use(authenticate);

router.post('/', authorize(ROLES.STUDENT), createRequestRules, validate, ctrl.create);
router.get('/', listRequestsRules, validate, ctrl.list);
router.get('/:id', requestIdRule, validate, ctrl.getOne);

router.patch('/:id/review', authorize(ROLES.CLERK), requestIdRule, validate, ctrl.review);
router.patch('/:id/approve', authorize(ROLES.HOD), requestIdRule, validate, ctrl.approve);
router.patch('/:id/reject', authorize(ROLES.HOD), rejectRules, validate, ctrl.reject);

// Auth and role are checked BEFORE the upload body is parsed.
router.post('/:id/document', authorize(ROLES.CLERK), requestIdRule, validate, uploadSingle, ctrl.uploadDocument);
router.get('/:id/document', requestIdRule, validate, ctrl.downloadDocument);

module.exports = router;
