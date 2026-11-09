'use strict';

// Read-only lists for forms. /departments is public (registration needs it before sign-in);
// /options needs a session. Both are inside the institution's own tenant context.
const router = require('express').Router();
const ctrl = require('../controllers/configController');
const authenticate = require('../middleware/authenticate');

router.get('/departments', ctrl.publicDepartments);
router.get('/options', authenticate, ctrl.options);

module.exports = router;
