const {
  listActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  ActivityNotFoundError,
  ActivityForbiddenError,
  InvalidTimezoneError,
} = require('./activities.service');
const logger = require('../../shared/utils/logger');

const handleKnownErrors = (res, error) => {
  if (error instanceof ActivityNotFoundError || error instanceof ActivityForbiddenError) {
    res.status(error.statusCode).json({ error: error.name, message: error.message });
    return true;
  }
  return false;
};

const getActivities = async (req, res) => {
  const { date, timezone, source } = req.query;

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Bad Request', message: 'date debe tener formato YYYY-MM-DD' });
  }

  if (date && !timezone) {
    return res.status(400).json({ error: 'Bad Request', message: 'timezone es requerido cuando se filtra por date' });
  }

  try {
    const activities = await listActivities(req.user.id, { date, timezone, source });
    return res.status(200).json(activities);
  } catch (error) {
    if (error instanceof InvalidTimezoneError) {
      return res.status(400).json({ error: error.name, message: error.message });
    }
    logger.error('Error al listar actividades', { error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'No se pudieron obtener las actividades' });
  }
};

const postActivity = async (req, res) => {
  const { activityType, startTime, endTime, metadata } = req.body;

  if (!activityType || !startTime || !endTime) {
    return res.status(400).json({ error: 'Bad Request', message: 'activityType, startTime y endTime son requeridos' });
  }

  if (new Date(startTime) >= new Date(endTime)) {
    return res.status(400).json({ error: 'Bad Request', message: 'startTime debe ser anterior a endTime' });
  }

  try {
    const activity = await createActivity(req.user.id, { activityType, startTime, endTime, metadata });
    return res.status(201).json(activity);
  } catch (error) {
    logger.error('Error al crear actividad', { error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'No se pudo crear la actividad' });
  }
};

const putActivity = async (req, res) => {
  const { title, activityType, startTime, endTime, metadata } = req.body;

  if (startTime && endTime && new Date(startTime) >= new Date(endTime)) {
    return res.status(400).json({ error: 'Bad Request', message: 'startTime debe ser anterior a endTime' });
  }

  try {
    const activity = await updateActivity(req.user.id, req.params.id, { title, activityType, startTime, endTime, metadata });
    return res.status(200).json(activity);
  } catch (error) {
    if (handleKnownErrors(res, error)) return;
    logger.error('Error al actualizar actividad', { error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'No se pudo actualizar la actividad' });
  }
};

const deleteActivityHandler = async (req, res) => {
  try {
    await deleteActivity(req.user.id, req.params.id);
    return res.status(204).send();
  } catch (error) {
    if (handleKnownErrors(res, error)) return;
    logger.error('Error al eliminar actividad', { error });
    return res.status(500).json({ error: 'Internal Server Error', message: 'No se pudo eliminar la actividad' });
  }
};

module.exports = { getActivities, postActivity, putActivity, deleteActivityHandler };
