const { Router } = require('express');
const { redirectToGoogle, googleCallback, createBootstrapAdmin } = require('./auth.controller');

const router = Router();

router.get('/google', redirectToGoogle);
router.get('/google/callback', googleCallback);
router.post('/bootstrap-admin', createBootstrapAdmin);

module.exports = router;
