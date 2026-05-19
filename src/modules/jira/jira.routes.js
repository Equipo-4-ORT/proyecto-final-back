/**
 * Rutas del módulo Jira. Prefijo: `/api/jira` (montado en `src/app.js`).
 *
 * El callback es público por diseño — la autorización va por el `state` OAuth.
 * El resto requiere JWT válido via authMiddleware.
 */

const express = require('express');
const authMiddleware = require('../../shared/middleware/authMiddleware');
const controller = require('./jira.controller');

const router = express.Router();

router.get('/auth',          authMiddleware, controller.getAuthUrl);
router.get('/auth/callback',                controller.handleCallback);
router.get('/status',        authMiddleware, controller.getStatus);
router.delete('/connection', authMiddleware, controller.disconnect);
router.post('/sync',         authMiddleware, controller.triggerSync);

module.exports = router;
