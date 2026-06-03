const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const requireRole = require('../../shared/middleware/requireRole');
const { postUser, getUsers, patchUserStatus, editUser } = require('./admin.controller');

// 1) authMiddleware: token válido. 2) requireActiveUser: el usuario existe y
// está activo en la BD (refresca req.user). 3) requireRole: role ADMIN vigente.
router.use(authMiddleware);
router.use(requireActiveUser);
router.use(requireRole('ADMIN'));

router.post('/users', postUser);
router.get('/users', getUsers);
router.patch('/users/:id/status', patchUserStatus);

router.put('/users/:id', editUser);

module.exports = router;
