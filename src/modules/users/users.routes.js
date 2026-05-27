const express = require('express');
const { authMiddleware } = require('../../shared/middleware');
const { apiLimiter } = require('../../shared/middleware/rateLimiter');
const {syncCalendar} = require('../calendar/calendar.controller');
const { decrypt } = require('../../shared/utils/crypto');



const router = express.Router();

router.use(apiLimiter);
router.use(authMiddleware);

router.post('/sync-calendar', syncCalendar);


// Aquí irían las rutas de usuarios

module.exports = router;
