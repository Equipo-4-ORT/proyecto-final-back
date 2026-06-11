/**
 * Rutas del módulo Jira. Prefijo: `/api/jira` (montado en `src/app.js`).
 *
 * El callback es público por diseño — la autorización va por el `state` OAuth.
 * El resto requiere JWT válido via authMiddleware.
 */

const express = require('express');
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const requireRole = require('../../shared/middleware/requireRole');
const controller = require('./jira.controller');

const router = express.Router();

// El callback de OAuth es público (la autorización va por el `state`).
// El resto exige sesión válida + usuario activo + rol EMPLOYEE.
router.get('/auth',          authMiddleware, requireActiveUser, requireRole('EMPLOYEE'), controller.getAuthUrl);
router.get('/auth/callback',                controller.handleCallback);
router.get('/status',        authMiddleware, requireActiveUser, requireRole('EMPLOYEE'), controller.getStatus);
router.delete('/connection', authMiddleware, requireActiveUser, requireRole('EMPLOYEE'), controller.disconnect);
router.post('/sync',         authMiddleware, requireActiveUser, requireRole('EMPLOYEE'), controller.triggerSync);

module.exports = router;
