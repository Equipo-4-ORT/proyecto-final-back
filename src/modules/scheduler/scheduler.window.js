/**
 * Armado de la ventana de jornada laboral del batch diario.
 *
 * `workStartTime` / `workEndTime` se guardan en la BD como wall-clock "HH:MM" SIN
 * zona. Para sincronizar hay que resolverlos a instantes absolutos (UTC) usando la
 * timezone del despliegue (SCHEDULER_TIMEZONE). Este módulo es puro: recibe la TZ
 * por parámetro, no lee config, así es trivial de testear.
 */

const { DateTime } = require('luxon');

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

class InvalidWorkdayWindowError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidWorkdayWindowError';
    }
}

/**
 * Parsea "HH:MM" (24h) a { hour, minute }. Lanza si el formato es inválido.
 * @param {string} value
 * @param {string} label - para el mensaje de error
 */
const parseHHMM = (value, label) => {
    const match = typeof value === 'string' ? value.match(HHMM_REGEX) : null;
    if (!match) {
        throw new InvalidWorkdayWindowError(`${label} inválido: "${value}". Debe ser "HH:MM" en formato 24h.`);
    }
    return { hour: Number(match[1]), minute: Number(match[2]) };
};

/**
 * Resuelve `referenceDate` a un DateTime de luxon en `timezone`. Acepta DateTime,
 * Date, string ISO, o nada (usa "ahora").
 */
const toRefDateTime = (referenceDate, timezone) => {
    if (DateTime.isDateTime(referenceDate)) return referenceDate.setZone(timezone);
    if (referenceDate instanceof Date) return DateTime.fromJSDate(referenceDate, { zone: timezone });
    if (typeof referenceDate === 'string') return DateTime.fromISO(referenceDate, { zone: timezone });
    return DateTime.now().setZone(timezone);
};

/**
 * Construye la ventana [start, end) de la jornada laboral de un usuario, en UTC.
 *
 * El batch dispara a `workEndTime`, así que `end` cae en la fecha de `referenceDate`
 * (normalmente "hoy" en `timezone`) a esa hora. `start` cae a `workStartTime`.
 *
 * Cruce de medianoche (turno nocturno, RN-B11): si `workEndTime <= workStartTime`,
 * la jornada empezó el día calendario anterior, así que `start` retrocede un día.
 * El borde `workStartTime == workEndTime` queda como jornada de 24h.
 *
 * @param {string} workStartTime - "HH:MM" 24h
 * @param {string} workEndTime   - "HH:MM" 24h
 * @param {DateTime|Date|string} [referenceDate] - día/momento de referencia (default: ahora)
 * @param {string} timezone - identificador IANA
 * @returns {{ start: Date, end: Date }} instantes absolutos en UTC
 * @throws {InvalidWorkdayWindowError} si las horas o la timezone son inválidas
 */
const buildWorkdayWindow = (workStartTime, workEndTime, referenceDate, timezone) => {
    const ref = toRefDateTime(referenceDate, timezone);
    if (!ref.isValid) {
        throw new InvalidWorkdayWindowError(`Timezone o fecha de referencia inválida (tz: "${timezone}").`);
    }

    const start = parseHHMM(workStartTime, 'workStartTime');
    const end = parseHHMM(workEndTime, 'workEndTime');

    const base = { second: 0, millisecond: 0 };
    let startDt = ref.set({ hour: start.hour, minute: start.minute, ...base });
    const endDt = ref.set({ hour: end.hour, minute: end.minute, ...base });

    // Si la jornada termina a la misma hora o antes de empezar, cruzó la medianoche:
    // el inicio fue el día anterior (incluye el borde start == end → ventana de 24h).
    if (endDt.toMillis() <= startDt.toMillis()) {
        startDt = startDt.minus({ days: 1 });
    }

    // Defensa: tras el ajuste, start siempre debería ser anterior a end.
    if (startDt.toMillis() >= endDt.toMillis()) {
        throw new InvalidWorkdayWindowError(
            `Ventana inválida tras resolver la jornada (start=${startDt.toISO()}, end=${endDt.toISO()}).`,
        );
    }

    return {
        start: startDt.toUTC().toJSDate(),
        end: endDt.toUTC().toJSDate(),
    };
};

module.exports = {
    buildWorkdayWindow,
    InvalidWorkdayWindowError,
};
