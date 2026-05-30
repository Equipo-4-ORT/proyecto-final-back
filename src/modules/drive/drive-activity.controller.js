const { persistDriveActivities, InvalidWindowError } = require('./drive-activity.service');
const prisma = require('../../shared/database/prisma');
const { decrypt } = require('../../shared/utils/crypto');
const logger = require('../../shared/utils/logger');

// El sync recibe la ventana [startTime, endTime) ya resuelta a instantes
// absolutos (ISO 8601). Hoy se prueba por Postman pasando el rango a mano.
//
// TODO (jornada laboral — este sprint): este sync lo va a disparar un batch que
// arma la ventana a partir de la jornada laboral del usuario (hora inicio/fin +
// timezone, que vivirán en la BD). No hay front: la ventana no la define el cliente.
const syncDriveActivities = async (req, res) => {
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'startTime y endTime son requeridos (ISO 8601)',
        });
    }

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { refreshToken: true },
        });

        if (!user || !user.refreshToken) {
            return res.status(400).json({ error: 'Usuario no encontrado o sin token de actualización' });
        }

        const decryptedToken = decrypt(user.refreshToken);
        const result = await persistDriveActivities(userId, decryptedToken, startTime, endTime);
        res.status(200).json(result);
    } catch (error) {
        if (error instanceof InvalidWindowError) {
            return res.status(400).json({ error: error.name, message: error.message });
        }
        logger.error('Error sincronizando actividades de Drive', { message: error.message, code: error.code });
        res.status(500).json({ error: 'Error sincronizando actividades de Drive' });
    }
};

module.exports = { syncDriveActivities };
