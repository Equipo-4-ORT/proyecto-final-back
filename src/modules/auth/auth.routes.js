const { Router } = require('express');
const {
  redirectToGoogle,
  googleCallback,
  createBootstrapAdmin,
  refresh,
  logout,
  me,
} = require('./auth.controller');
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');

const router = Router();

router.get('/google', redirectToGoogle);
router.get('/google/callback', googleCallback);
router.post('/refresh', refresh); // lee refresh_token cookie, rota y emite access nuevo
router.post('/logout', logout); // revoca la sesión actual y limpia cookies
router.get('/me', authMiddleware, requireActiveUser, me); // requireActiveUser revalida contra DB
router.post('/bootstrap-admin', createBootstrapAdmin);

module.exports = router;
