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

        const updatedSettings = await updateUserSettings(userId, { workStartTime, workEndTime, avoidOverlaps });
        return res.status(200).json(updatedSettings);
    } catch (error) {
        if (error.message.includes('invalido') || error.message.includes('mayor')) {
            return res.status(400).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Error updating user settings' });
    }
};

module.exports = {
    getSettings,
    updateSettings,
};