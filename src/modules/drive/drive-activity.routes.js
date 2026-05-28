const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireValidGoogleToken = require('../../shared/middleware/requireValidGoogleToken');
const { syncDriveActivities } = require('./drive-activity.controller');

router.use(authMiddleware);
router.use(requireValidGoogleToken);

router.post('/sync', syncDriveActivities);

module.exports = router;
