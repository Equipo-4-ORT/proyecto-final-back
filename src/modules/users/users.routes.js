const express = require('express');
const { authMiddleware } = require('../../shared/middleware');
const { getSettings, updateSettings } = require('./users.controller');

const router = express.Router();

// El rate limiting lo aplica el mount global de '/api' en app.js
router.use(authMiddleware);

router.get('/me/settings', getSettings);
router.put('/me/settings', updateSettings);

// Aquí irían las rutas de usuarios

module.exports = router;
