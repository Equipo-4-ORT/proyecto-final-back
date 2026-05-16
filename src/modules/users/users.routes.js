const express = require('express');
const { authMiddleware } = require('../../shared/middleware');

const router = express.Router();

router.use(authMiddleware);

// Aquí irían las rutas de usuarios

module.exports = router;
