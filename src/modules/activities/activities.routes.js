const express = require('express');
const router = express.Router();
const authMiddleware = require('../../shared/middleware/authMiddleware');
const requireActiveUser = require('../../shared/middleware/requireActiveUser');
const { getActivities, postActivity, putActivity, deleteActivityHandler } = require('./activities.controller');

router.use(authMiddleware);
router.use(requireActiveUser);

router.get('/', getActivities);
router.post('/', postActivity);
router.put('/:id', putActivity);
router.delete('/:id', deleteActivityHandler);

module.exports = router;
