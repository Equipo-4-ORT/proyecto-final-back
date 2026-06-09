/**
 * Lógica del tick del dispatcher (CU-01 de la SPEC).
 *
 * Cada minuto: calcula HH:MM (24h) en SCHEDULER_TIMEZONE, busca los empleados
 * activos cuyo workEndTime coincide y los procesa.
 *
 * Fan-out con cola + pool compartido: los usuarios matcheados se encolan y los
 * drena un pool de a lo sumo `schedulerConcurrency` workers. A diferencia de un
 * guard de "tick en curso", esto acota la concurrencia TOTAL entre ticks sin
 * saltear usuarios cuando el pico tarda más de un minuto (SPEC §8 E-03, CU-01 4a).
 * Un set `pending` dedupea por usuario+día para no procesar dos veces (E-09).
 */

const { DateTime } = require('luxon');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const config = require('../../shared/config');
const { buildWorkdayWindow } = require('./scheduler.window');
const { syncUserActivities } = require('./userSync.service');
const mailService = require('../mail/mail.service');

// Campos que necesitan el orquestador y el email.
const USER_SELECT = {
    id: true,
    email: true,
    workStartTime: true,
    workEndTime: true,
    refreshToken: true,
    googleReconnectRequired: true,
    jiraRefreshToken: true,
    jiraCloudId: true,
    jiraReconnectRequired: true,
};

const state = {
    queue: [],          // [{ user, nowInTz, dayKey }]
    pending: new Set(), // dayKeys encolados o en proceso (dedupe E-09)
    drainPromise: null, // promesa del drenado en curso (null si está idle)
};

/**
 * Procesa un usuario: arma la ventana, sincroniza y —si hubo actividad nueva—
 * le avisa por email. Nunca lanza: aísla el fallo para no frenar el lote (RN-B05).
 */
const processUser = async (user, nowInTz) => {
    try {
        const window = buildWorkdayWindow(user.workStartTime, user.workEndTime, nowInTz, config.schedulerTimezone);
        const { totalImported } = await syncUserActivities(user, window);

        // Email solo si se importó actividad NUEVA. Esto además evita el doble aviso
        // si el mismo usuario se procesa dos veces (p. ej. doble match por DST): el
        // segundo run importa 0 y no reenvía (RN-B04/B07).
        if (totalImported > 0) {
            try {
                await mailService.sendActivityReadyEmail(user.email, { date: nowInTz.toFormat('yyyy-LL-dd') });
                logger.info('scheduler.email.sent', { userId: user.id });
            } catch (error) {
                logger.error('scheduler.email.failed', { userId: user.id, message: error.message });
            }
        }
    } catch (error) {
        logger.error('scheduler.user.fatal', { userId: user.id, message: error.message });
    }
};

/** Un worker consume de la cola hasta vaciarla. */
const worker = async () => {
    while (state.queue.length > 0) {
        const job = state.queue.shift();
        try {
            await processUser(job.user, job.nowInTz);
        } finally {
            state.pending.delete(job.dayKey);
        }
    }
};

/**
 * Drena la cola con a lo sumo `schedulerConcurrency` workers. Si ya hay un drenado
 * en curso, reusa su promesa (los workers existentes toman lo nuevo encolado). El
 * do/while recontrola la cola al final para cubrir el caso de items agregados
 * justo cuando los workers estaban terminando.
 */
const drain = () => {
    if (!state.drainPromise) {
        state.drainPromise = (async () => {
            const limit = config.schedulerConcurrency;
            do {
                const workers = [];
                for (let i = 0; i < limit && state.queue.length > 0; i += 1) {
                    workers.push(worker());
                }
                await Promise.all(workers);
            } while (state.queue.length > 0);
            state.drainPromise = null;
        })();
    }
    return state.drainPromise;
};

/**
 * Ejecuta un tick. Devuelve { matched, enqueued }. Espera a que se drene la cola
 * (no bloquea al cron: éste dispara un callback nuevo por minuto de todos modos, y
 * la dedupe vuelve seguros los solapamientos).
 *
 * @param {DateTime} [now] - inyectable para tests; default: ahora.
 */
const runTick = async (now = DateTime.now()) => {
    const tz = config.schedulerTimezone;
    const nowInTz = now.setZone(tz);
    const hhmm = nowInTz.toFormat('HH:mm'); // 24h (RN-B13): 09:00 ≠ 21:00

    const users = await prisma.user.findMany({
        where: { role: 'EMPLOYEE', status: 'ACTIVE', workEndTime: hhmm },
        select: USER_SELECT,
    });

    if (users.length === 0) {
        return { matched: 0, enqueued: 0 };
    }

    const day = nowInTz.toFormat('yyyy-LL-dd');
    let enqueued = 0;
    for (const user of users) {
        const dayKey = `${user.id}:${day}`;
        if (state.pending.has(dayKey)) continue; // ya en cola o en proceso (E-09)
        state.pending.add(dayKey);
        state.queue.push({ user, nowInTz, dayKey });
        enqueued += 1;
    }

    logger.info('scheduler.tick', {
        hhmm,
        matched: users.length,
        enqueued,
        concurrency: config.schedulerConcurrency,
    });

    await drain();
    return { matched: users.length, enqueued };
};

module.exports = {
    runTick,
    processUser,
    // Para tests: limpia el estado del pool entre casos.
    _resetState: () => {
        state.queue = [];
        state.pending = new Set();
        state.drainPromise = null;
    },
};
