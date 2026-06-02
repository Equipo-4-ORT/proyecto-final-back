const { getUserSettings, updateUserSettings } = require('./users.service');

const getSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const settings = await getUserSettings(userId);
        return res.status(200).json(settings);
    } catch (error) {
        return res.status(500).json({ error: 'Error fetching user settings' });
    }
};

const updateSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const { workStartTime, workEndTime, avoidOverlaps } = req.body;

       const updatedSettings = await updateUserSettings(userId, { 
      workStartTime, 
      workEndTime, 
      avoidOverlaps 
    });
        return res.status(200).json(updatedSettings);
    } catch (error) {
       if (error.statusCode === 400 || error.name === 'UserValidationError') {
      return res.status(400).json({ error: error.message });
    }
        console.error('Error al actualizar las configuraciones:', error);
    return res.status(500).json({ error: 'Ocurrió un error interno al actualizar las configuraciones.' });
    }
};

module.exports = {
    getSettings,
    updateSettings,
};