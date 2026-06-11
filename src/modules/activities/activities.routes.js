const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const requireRole = require('../../shared/middleware/requireRole');
const { getActivities, postActivity, putActivity, deleteActivityHandler } = require('./activities.controller');

router.use(authMiddleware);
router.use(requireActiveUser);
router.use(requireRole('EMPLOYEE'));

router.get('/', getActivities);
router.post('/', postActivity);
router.put('/:id', putActivity);
router.delete('/:id', deleteActivityHandler);

module.exports = router;
