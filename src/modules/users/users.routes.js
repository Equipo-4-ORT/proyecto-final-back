const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../shared/middleware');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');
const { getSettings, updateSettings } = require('./users.controller');

const router = express.Router();

router.use(apiLimiter);
router.use(authMiddleware);
router.get('/me/settings', authMiddleware, getSettings);
router.put('/me/settings', authMiddleware, updateSettings);



// Aquí irían las rutas de usuarios

module.exports = router;
