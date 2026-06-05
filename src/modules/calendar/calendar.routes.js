const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const requireValidGoogleToken = require('../../shared/middleware/requireValidGoogleToken');
const { syncCalendar } = require('./calendar.controller');

router.use(authMiddleware);
router.use(requireActiveUser);
router.use(requireValidGoogleToken);

router.post('/sync', syncCalendar);

module.exports = router;
