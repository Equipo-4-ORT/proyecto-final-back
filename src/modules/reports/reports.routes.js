const express = require('express');
const { authMiddleware } = require('../../shared/middleware');
const { getReports } = require('./reports.controller');

const router = express.Router();

router.get('/', authMiddleware, getReports);

module.exports = router;
