const express = require('express');
const router = express.Router();
const { getReports } = require('./reports.controller');
const authMiddleware = require('../../shared/middleware/authMiddleware');

router.get('/', authMiddleware, getReports);

module.exports = router;