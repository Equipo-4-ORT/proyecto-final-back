const express = require('express');
const router = express.Router();
const { googleLoginCallback, refreshTokenCallBack } = require('./auth.controller');


// POST /auth/google

router.post('/google', googleLoginCallback);



router.post('/refresh', refreshTokenCallBack);

module.exports = router;