const { router } = require('express');
const { authMiddleware } = require('../../shared/middleware');
//faltan los controladores todavia

const router = router();

router.use(authMiddleware);

// Aquí irían las rutas de usuarios

module.exports = router;
