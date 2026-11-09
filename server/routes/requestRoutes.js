'use strict';

const router = require('express').Router();
const ctrl = require('../controllers/requestController');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const uploadSingle = require('../middleware/upload');
const { ROLES } = require('../config/constants');
const { createRequestRules, requestIdRule, listRequestsRules, rejectRules, needsInfoRules, resubmitRules } = require('../validators/requestValidators');

const STAFF = [ROLES.CLERK, ROLES.HOD, ROLES.PRINCIPAL];

router.use(authenticate);

router.post('/', authorize(ROLES.STUDENT), createRequestRules, validate, ctrl.create);
router.get('/', listRequestsRules, validate, ctrl.list);
router.get('/:id', requestIdRule, validate, ctrl.getOne);

// Which staff role may act is decided by the request's workflow step (in the service), not by
// the route: any staff role may reach these, and the engine answers 403/404/409 precisely.
// /review and /approve are kept as named shortcuts; /advance completes whatever step is current.
router.patch('/:id/review', authorize(...STAFF), requestIdRule, validate, ctrl.review);
router.patch('/:id/approve', authorize(...STAFF), requestIdRule, validate, ctrl.approve);
router.patch('/:id/advance', authorize(...STAFF), requestIdRule, validate, ctrl.advanceStep);
router.patch('/:id/reject', authorize(...STAFF), rejectRules, validate, ctrl.reject);
router.patch('/:id/needs-info', authorize(...STAFF), needsInfoRules, validate, ctrl.needsInfo);
router.patch('/:id/resubmit', authorize(ROLES.STUDENT), resubmitRules, validate, ctrl.resubmit);

// Auth and role are checked BEFORE the upload body is parsed.
router.post('/:id/document', authorize(ROLES.CLERK), requestIdRule, validate, uploadSingle, ctrl.uploadDocument);
router.get('/:id/document', requestIdRule, validate, ctrl.downloadDocument);

module.exports = router;
