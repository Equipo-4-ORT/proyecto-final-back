const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const requireRole = require('../../shared/middleware/requireRole');
const requireValidGoogleToken = require('../../shared/middleware/requireValidGoogleToken');
const { syncCalendar } = require('./calendar.controller');

router.use(authMiddleware);
router.use(requireActiveUser);
router.use(requireRole('EMPLOYEE'));
router.use(requireValidGoogleToken);

router.post('/sync', syncCalendar);

module.exports = router;
