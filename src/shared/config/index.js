/**
 * Configuración centralizada de la aplicación.
 * Los módulos deben importar desde aquí en vez de leer process.env directamente.
 * Nota: jira.constants.js tiene su propia config con validación requireEnv;
 * migrarla acá es el siguiente paso de refactor.
 */
const { DateTime } = require('luxon');

const config = {
    get frontendBaseUrl() { return process.env.FRONTEND_BASE_URL; },
    get port() { return Number(process.env.PORT) || 3000; },
    get nodeEnv() { return process.env.NODE_ENV || 'development'; },

    // —— Scheduler (batch diario de sincronización; ver ADR-004 / SPEC F6-01) ——
    // Habilitado salvo que SCHEDULER_ENABLED sea explícitamente 'false' (útil en dev/test).
    get schedulerEnabled() {
        return String(process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false';
    },
    // Timezone IANA con la que se interpreta workEndTime y se arman las ventanas.
    get schedulerTimezone() { return process.env.SCHEDULER_TIMEZONE; },
    // Máximo de usuarios procesados en paralelo en el pool del fan-out.
    get schedulerConcurrency() {
        const n = Number(process.env.SCHEDULER_CONCURRENCY);
        return Number.isInteger(n) && n > 0 ? n : 5;
    },

    // —— SMTP (email de aviso del batch) ——
    get smtp() {
        return {
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: String(process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
            from: process.env.SMTP_FROM,
        };
    },
    // El email degrada si no hay SMTP configurado (V-02). Mínimo: host + from.
    get smtpConfigured() {
        return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
    },
};

/**
 * Valida que `tz` sea un identificador IANA válido (vía luxon). No lanza.
 * @param {string} tz
 * @returns {boolean}
 */
const isValidTimezone = (tz) => {
    if (!tz || typeof tz !== 'string') return false;
    return DateTime.now().setZone(tz).isValid;
};

/**
 * Valida la configuración del scheduler. No lanza: devuelve un resultado para que
 * el caller (server.js) decida NO arrancar el batch y seguir sirviendo la API
 * (fail-fast acotado; ver SPEC V-01 / CA-09).
 * @returns {{ valid: boolean, timezone?: string, error?: string }}
 */
const validateSchedulerConfig = () => {
    const tz = config.schedulerTimezone;
    if (!isValidTimezone(tz)) {
        return {
            valid: false,
            error: `SCHEDULER_TIMEZONE inválida o ausente: "${tz ?? ''}". Debe ser un identificador IANA (ej: America/Argentina/Buenos_Aires).`,
        };
    }
    return { valid: true, timezone: tz };
};

module.exports = config;
module.exports.isValidTimezone = isValidTimezone;
module.exports.validateSchedulerConfig = validateSchedulerConfig;
