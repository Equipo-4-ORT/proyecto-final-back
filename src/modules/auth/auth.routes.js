const { Router } = require('express');
const { redirectToGoogle, googleCallback } = require('./auth.controller');

const router = Router();

router.get('/google', redirectToGoogle);
router.get('/google/callback', googleCallback);

module.exports = router;
