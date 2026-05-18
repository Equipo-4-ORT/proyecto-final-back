const express = require('express');
const { authMiddleware, requireValidGoogleToken } = require('../../shared/middleware');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');

const router = express.Router();

router.use(apiLimiter);
router.use(authMiddleware);
router.get('/prueba-google', authMiddleware, requireValidGoogleToken, (req, res) => {
    res.json({
        success: true,
        message: '¡Pudiste entrar! Tu JWT es válido y Google confirmó que tu refresh token sigue vivo.'
    });
});

// Aquí irían las rutas de usuarios

module.exports = router;
