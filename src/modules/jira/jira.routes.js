/**
 * Rutas del módulo Jira. Prefijo: `/api/jira` (montado en `src/app.js`).
 *
 * TODO (F1-05): insertar el middleware de auth interno (`requireAuth`) en todas
 * las rutas MENOS el callback. El callback se autoriza por el `state` OAuth.
 */

const express = require('express');
const controller = require('./jira.controller');

const router = express.Router();

router.get('/auth', controller.getAuthUrl);
router.get('/auth/callback', controller.handleCallback);
router.get('/status', controller.getStatus);
router.delete('/connection', controller.disconnect);
router.post('/sync', controller.triggerSync);

module.exports = router;
