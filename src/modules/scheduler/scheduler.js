/**
 * Dispatcher del batch diario: registra el job node-cron y maneja su ciclo de vida.
 *
 * `start()` no lanza: si el batch está deshabilitado o la timezone es inválida,
 * loguea y no arranca, pero la API sigue viva (fail-fast acotado; SPEC V-01 / CA-09).
 */

const cron = require('node-cron');
const logger = require('../../shared/utils/logger');
const config = require('../../shared/config');
const { validateSchedulerConfig } = require('../../shared/config');
const { runTick } = require('./scheduler.service');

let task = null;

/**
 * Arranca el dispatcher (cron cada minuto). Idempotente.
 * @returns {boolean} true si quedó activo.
 */
const start = () => {
    if (!config.schedulerEnabled) {
        logger.info('scheduler.disabled', { reason: 'SCHEDULER_ENABLED=false' });
        return false;
    }

    const validation = validateSchedulerConfig();
    if (!validation.valid) {
        logger.error('scheduler.config_invalid', { error: validation.error });
        return false;
    }

    if (task) {
        logger.warn('scheduler.already_started');
        return true;
    }

    task = cron.schedule(
        '* * * * *',
        async () => {
            try {
                await runTick();
            } catch (error) {
                logger.error('scheduler.tick_error', { message: error.message });
            }
        },
        { timezone: validation.timezone },
    );

    logger.info('scheduler.started', {
        timezone: validation.timezone,
        concurrency: config.schedulerConcurrency,
    });
    return true;
};

/** Detiene el dispatcher (para el shutdown graceful). Idempotente. */
const stop = () => {
    if (task) {
        task.stop();
        task = null;
        logger.info('scheduler.stopped');
    }
};

module.exports = { start, stop };
