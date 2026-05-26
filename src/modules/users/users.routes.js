const express = require('express');
const { authMiddleware} = require('../../shared/middleware');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');
const { persistCalendarActivities } = require('../calendar/calendar.service');
const { decrypt } = require('../../shared/utils/crypto');



const router = express.Router();

router.use(apiLimiter);
router.use(authMiddleware);

router.post('/test-sync-calendar', async (req, res) => {
  try {
    const { userId, refreshToken, date } = req.body;

    const tokenRealDecifrado = decrypt(refreshToken);
    
    // Llamamos a tu servicio pasándole los datos crudos
    const result = await persistCalendarActivities(userId, tokenRealDecifrado, date);
    
    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Aquí irían las rutas de usuarios

module.exports = router;
