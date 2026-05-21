const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireRole = require('../../shared/middleware/requireRole');
const { postUser, getUsers, patchUserStatus } = require('./admin.controller');

router.use(authMiddleware);
router.use(requireRole('ADMIN'));

router.post('/users', postUser);
router.get('/users', getUsers);
router.patch('/users/:id/status', patchUserStatus);

module.exports = router;
