const express = require('express');
const { authMiddleware } = require('../../shared/middleware');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');

const router = express.Router();

router.use(apiLimiter);
router.use(authMiddleware);


// Aquí irían las rutas de usuarios

module.exports = router;
