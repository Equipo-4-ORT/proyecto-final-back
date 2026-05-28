const { persistDriveActivities } = require('./drive-activity.service');
const prisma = require('../../shared/database/prisma');
const { decrypt } = require('../../shared/utils/crypto');
const logger = require('../../shared/utils/logger');

const syncDriveActivities = async (req, res) => {
    try {
        const userId = req.user.id;
        const { date } = req.body;

        if (!date) {
            return res.status(400).json({ error: 'La fecha es requerida' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { refreshToken: true },
        });

        if (!user || !user.refreshToken) {
            return res.status(400).json({ error: 'Usuario no encontrado o sin token de actualización' });
        }

        const decryptedToken = decrypt(user.refreshToken);
        const result = await persistDriveActivities(userId, decryptedToken, date);
        res.status(200).json(result);
    } catch (error) {
        logger.error('Error sincronizando actividades de Drive', { error });
        res.status(500).json({ error: 'Error sincronizando actividades de Drive' });
    }
};

module.exports = { syncDriveActivities };
