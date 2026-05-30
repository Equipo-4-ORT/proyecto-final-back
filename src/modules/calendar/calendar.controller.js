const { persistCalendarActivities } = require('./calendar.service');
const { getDecryptedRefreshToken } = require('../../shared/utils/refreshToken');
const logger = require('../../shared/utils/logger');

const syncCalendar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date } = req.body;

    // Esperamos la fecha del día a sincronizar en formato YYYY-MM-DD (mismo
    // contrato que /api/activities y que el formato `date` de los eventos
    // all-day de Calendar). Con esa fecha el service arma la ventana
    // [timeMin, timeMax) en RFC3339 que pide la API de Google Calendar.
    // Validamos shape + que sea una fecha real (ej: descarta 2026-13-40).
    const isValidDate =
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date));
    if (!isValidDate) {
      return res.status(400).json({ error: 'date es requerida y debe tener formato YYYY-MM-DD' });
    }

    const refreshToken = await getDecryptedRefreshToken(userId);
    if (!refreshToken) {
      return res.status(400).json({ error: 'Usuario no encontrado o sin token de actualización' });
    }

    const result = await persistCalendarActivities(userId, refreshToken, date);
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error sincronizando calendario', { message: error.message });
    res.status(500).json({ error: 'Error sincronizando calendario' });
  }
};

module.exports = {
  syncCalendar,
};
