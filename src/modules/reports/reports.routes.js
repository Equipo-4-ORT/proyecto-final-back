const express = require('express');
const { authMiddleware } = require('../../shared/middleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');
const { getReports, generateReport } = require('./reports.controller');

const router = express.Router();

router.get('/', authMiddleware, getReports);
router.post('/generate', authMiddleware, requireActiveUser, apiLimiter, generateReport);
module.exports = router;
