const prisma = require('../../shared/database/prisma');
const { DateTime } = require('luxon');

class ActivityNotFoundError extends Error {
  constructor() {
    super('Actividad no encontrada');
    this.name = 'ActivityNotFoundError';
    this.statusCode = 404;
  }
}

class ActivityForbiddenError extends Error {
  constructor() {
    super('No tenés permiso para modificar esta actividad');
    this.name = 'ActivityForbiddenError';
    this.statusCode = 403;
  }
}

class InvalidTimezoneError extends Error {
  constructor(timezone) {
    super(`Timezone inválida: "${timezone}"`);
    this.name = 'InvalidTimezoneError';
    this.statusCode = 400;
  }
}

/**
 * Convierte una fecha (YYYY-MM-DD) + timezone IANA al rango UTC equivalente
 * al día completo desde la perspectiva del usuario.
 *
 * Ejemplo: '2025-05-24' + 'America/Argentina/Buenos_Aires' (UTC-3)
 *   → gte: 2025-05-24T03:00:00.000Z  (medianoche en BsAs)
 *   → lt:  2025-05-25T03:00:00.000Z  (fin del día en BsAs)
 *
 * @param {string} date     - Fecha en formato YYYY-MM-DD
 * @param {string} timezone - Timezone IANA (ej: 'America/Argentina/Buenos_Aires')
 * @returns {{ gte: Date, lt: Date }}
 * @throws {InvalidTimezoneError} si el timezone no es un identificador IANA válido
 */
const dayToUTCRange = (date, timezone) => {
  const startOfDay = DateTime.fromISO(date, { zone: timezone }).startOf('day');

  if (!startOfDay.isValid) {
    throw new InvalidTimezoneError(timezone);
  }

  return {
    gte: startOfDay.toUTC().toJSDate(),
    lt:  startOfDay.plus({ days: 1 }).toUTC().toJSDate(),
  };
};

/**
 * Lista las actividades de un usuario con filtros opcionales.
 *
 * @param {string} userId
 * @param {object} [filters]
 * @param {string} [filters.date]     - Fecha YYYY-MM-DD para filtrar por día
 * @param {string} [filters.timezone] - Timezone IANA del usuario (requerido si se pasa date)
 * @param {string} [filters.source]   - Fuente a filtrar: 'drive', 'calendar', 'jira', 'manual'
 */
const listActivities = async (userId, filters = {}) => {
  const { date, timezone, source } = filters;

  const where = { userId };

  if (source) {
    where.source = source;
  }

  if (date && timezone) {
    where.startTime = dayToUTCRange(date, timezone);
  }

  // Solo exponer al front actividades de Drive con fileType relevante.
  // El resto queda en BD pero no se devuelve.
  where.OR = [
    { source: { not: 'drive' } },
    { source: 'drive', fileType: { in: ['document', 'spreadsheet', 'presentation'] } },
  ];

  return prisma.dailyActivity.findMany({
    where,
    orderBy: { startTime: 'desc' },
  });
};

// Fallback de duración (en minutos) si por algún motivo el usuario no tuviera
// defaultDuration en la BD. La columna user.defaultDuration tiene @default(60),
// así que en la práctica siempre hay un valor; esto es defensivo.
const FALLBACK_DURATION_MINUTES = 60;

const createActivity = async (userId, { title, activityType, startTime, endTime, metadata }) => {
  const start = new Date(startTime);

  // Si no vino endTime, la duración la define la preferencia del usuario
  // (defaultDuration, en minutos). La regla de negocio vive acá, no en el front.
  let end;
  if (endTime) {
    end = new Date(endTime);
  } else {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { defaultDuration: true },
    });
    const durationMinutes = user?.defaultDuration ?? FALLBACK_DURATION_MINUTES;
    end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  }

  return prisma.dailyActivity.create({
    data: {
      userId,
      source: 'manual',
      title,
      activityType,
      startTime: start,
      endTime: end,
      metadata: metadata ?? undefined,
    },
  });
};

const updateActivity = async (userId, id, { title, activityType, startTime, endTime, metadata }) => {
  const activity = await prisma.dailyActivity.findUnique({ where: { id } });

  if (!activity) throw new ActivityNotFoundError();
  if (activity.userId !== userId) throw new ActivityForbiddenError();

  try {
    return await prisma.dailyActivity.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(activityType && { activityType }),
        ...(startTime && { startTime: new Date(startTime) }),
        ...(endTime && { endTime: new Date(endTime) }),
        ...(metadata !== undefined && { metadata }),
      },
    });
  } catch (error) {
    if (error.code === 'P2025') throw new ActivityNotFoundError();
    throw error;
  }
};

const deleteActivity = async (userId, id) => {
  const activity = await prisma.dailyActivity.findUnique({ where: { id } });

  if (!activity) throw new ActivityNotFoundError();
  if (activity.userId !== userId) throw new ActivityForbiddenError();

  try {
    await prisma.dailyActivity.delete({ where: { id } });
  } catch (error) {
    if (error.code === 'P2025') throw new ActivityNotFoundError();
    throw error;
  }
};

module.exports = {
  listActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  dayToUTCRange,
  ActivityNotFoundError,
  ActivityForbiddenError,
  InvalidTimezoneError,
};
