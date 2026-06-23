const { getUserSettings, updateUserSettings } = require('./users.service');
const logger = require('../../shared/utils/logger');

const getSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const settings = await getUserSettings(userId);
        return res.status(200).json(settings);
    } catch (error) {
        // UserNotFoundError trae statusCode 404
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        logger.error('Error al obtener las configuraciones del usuario', { error });
        return res.status(500).json({ error: 'Error fetching user settings' });
    }
};

const updateSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const { workStartTime, workEndTime, avoidOverlaps, defaultDuration } = req.body;

        const updatedSettings = await updateUserSettings(userId, {
            workStartTime,
            workEndTime,
            avoidOverlaps,
            defaultDuration,
        });
        return res.status(200).json(updatedSettings);
    } catch (error) {
        // UserValidationError (400) y UserNotFoundError (404) traen statusCode
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        logger.error('Error al actualizar las configuraciones', { error });
        return res.status(500).json({ error: 'Ocurrió un error interno al actualizar las configuraciones.' });
    }
};

module.exports = {
    getSettings,
    updateSettings,
};
