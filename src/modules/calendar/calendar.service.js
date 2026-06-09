const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { sanitizeText, MAX_TITLE_CHARS } = require('../../shared/utils/sanitize');

/**
 * Error tipado para una ventana [startTime, endTime) inválida (fechas no
 * parseables o startTime >= endTime). Lo usa persistCalendarActivitiesInWindow;
 * el controller (que sincroniza por `date`) no lo necesita.
 */
class InvalidWindowError extends Error {
  constructor(message = 'Ventana inválida: startTime y endTime deben ser ISO 8601 y startTime < endTime') {
    super(message);
    this.name = 'InvalidWindowError';
    this.statusCode = 400;
  }
}

const getCalendarEventsForDay = async (refreshToken, timeMin, timeMax) => {
  try {
    const auth = getAuthenticatedGoogleClient(refreshToken);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items || [];
  } catch (error) {
    logger.error('Error fetching calendar events', { message: error.message });
    throw new Error('Error fetching calendar events', { cause: error });
  }
};

/**
 * Mapea los eventos crudos de Calendar a filas de DailyActivity aplicando los
 * filtros de relevancia: solo eventos con hora exacta, con asistentes, que el
 * usuario aceptó explícitamente. Fuente única del parseo para los dos sync
 * (por `date` y por ventana).
 */
const mapEventsToActivities = (userId, rawEvents) => {
  const activitiesToSave = [];

  for (const event of rawEvents) {
    // Ignorar eventos sin hora exacta (ej: eventos de todo el día)
    if (!event.start?.dateTime || !event.end?.dateTime) {
      continue;
    }

    // Ignorar eventos sin asistentes (no representan participación con otras personas)
    if (!event.attendees || event.attendees.length === 0) {
      continue;
    }

    // Solo trackeamos eventos que el usuario aceptó explícitamente, sea
    // organizador o invitado. Google marca con `self: true` el registro del
    // usuario autenticado: si rechazó (declined) o no confirmó (needsAction /
    // tentative) el evento no se trackea.
    const self = event.attendees.find((a) => a.self);
    if (!self || self.responseStatus !== 'accepted') {
      continue;
    }

    const isMeet = event.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet';

    activitiesToSave.push({
      userId: userId,
      source: 'calendar',
      activityType: isMeet ? 'meeting' : 'event',
      externalId: event.id, // Usamos el ID del evento para evitar duplicados futuros
      startTime: new Date(event.start.dateTime),
      endTime: new Date(event.end.dateTime),
      metadata: {
        // El front lee `metadata.title` para todas las fuentes (Jira/Drive/Calendar);
        // antes el summary iba a la columna `title`, que el front no consume y por eso no
        // se mostraba. Saneamos + truncamos: `event.summary` lo controla cualquiera que
        // pueda invitar al usuario, así que es input no confiable.
        title: sanitizeText(event.summary, MAX_TITLE_CHARS) || 'Sin título',
        link: event.hangoutLink || null,
        organizer: event.organizer?.email || null,
      },
    });
  }

  return activitiesToSave;
};

/**
 * Persiste las actividades mapeadas. Idempotente vía skipDuplicates (externalId).
 */
const persistActivities = async (activitiesToSave) => {
  if (activitiesToSave.length === 0) {
    return { count: 0, message: 'No se encontraron actividades relevantes para guardar' };
  }

  const result = await prisma.dailyActivity.createMany({
    data: activitiesToSave,
    skipDuplicates: true, // Evita insertar actividades con el mismo externalId
  });

  return { count: result.count, message: `${result.count} actividades de calendario guardadas` };
};

/**
 * Sincroniza el día completo (UTC) a partir de una fecha YYYY-MM-DD.
 * Lo usa el endpoint HTTP (controller). El batch usa persistCalendarActivitiesInWindow.
 */
const persistCalendarActivities = async (userId, refreshToken, dateStr) => {
  const startDate = new Date(dateStr);
  const timeMin = startDate.toISOString();

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  const timeMax = endDate.toISOString();

  const rawEvents = await getCalendarEventsForDay(refreshToken, timeMin, timeMax);
  return persistActivities(mapEventsToActivities(userId, rawEvents));
};

/**
 * Sincroniza los eventos dentro de la ventana [startTime, endTime). Pensada para el
 * batch, que arma la ventana a partir de la jornada laboral del usuario (en
 * SCHEDULER_TIMEZONE → UTC). La ventana llega ya resuelta a instantes absolutos.
 *
 * @param {string} userId
 * @param {string} refreshToken - refresh token de Google ya descifrado
 * @param {string|Date} startTime - ISO 8601 con TZ
 * @param {string|Date} endTime   - ISO 8601 con TZ (exclusivo)
 * @returns {Promise<{count:number, message:string}>}
 * @throws {InvalidWindowError} si la ventana es inválida
 */
const persistCalendarActivitiesInWindow = async (userId, refreshToken, startTime, endTime) => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new InvalidWindowError();
  }

  const rawEvents = await getCalendarEventsForDay(refreshToken, start.toISOString(), end.toISOString());
  return persistActivities(mapEventsToActivities(userId, rawEvents));
};

module.exports = {
  getCalendarEventsForDay,
  persistCalendarActivities,
  persistCalendarActivitiesInWindow,
  InvalidWindowError,
};
