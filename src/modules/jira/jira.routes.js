/**
 * Rutas del módulo Jira. Prefijo: `/api/jira` (montado en `src/app.js`).
 *
 * El callback es público por diseño — la autorización va por el `state` OAuth.
 * El resto requiere JWT válido via authMiddleware.
 */

const express = require('express');
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const controller = require('./jira.controller');

const router = express.Router();

router.get('/auth',          authMiddleware, requireActiveUser, controller.getAuthUrl);
router.get('/auth/callback',                controller.handleCallback);
router.get('/status',        authMiddleware, requireActiveUser, controller.getStatus);
router.delete('/connection', authMiddleware, requireActiveUser, controller.disconnect);
router.post('/sync',         authMiddleware, requireActiveUser, controller.triggerSync);

module.exports = router;
