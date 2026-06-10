/**
 * Orquestador de sincronización por usuario (CU-02 de la SPEC).
 *
 * Para un usuario y una ventana [start, end), sincroniza las fuentes que tiene
 * conectadas (Calendar, Drive, Jira) reusando los servicios existentes. Aísla
 * errores por fuente (RN-B05/B06): el fallo de una no frena a las otras ni al
 * batch. Devuelve los conteos; NO envía email (eso lo decide el dispatcher según
 * cuántas actividades nuevas se importaron).
 */

const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { decrypt } = require('../../shared/utils/crypto');
const calendarService = require('../calendar/calendar.service');
const driveService = require('../drive/drive-activity.service');
const jiraService = require('../jira/jira.service');

/**
 * Detecta si un error (o su cadena de `cause`) parece un fallo de autenticación de
 * Google (token revocado/expirado): `invalid_grant` o status 400/401. Calendar y
 * Drive envuelven el error original en `error.cause`, por eso se recorre la cadena.
 */
const looksLikeGoogleAuthError = (err) => {
    if (!err) return false;
    const msg = String(err.message || '');
    const status = err.response?.status ?? err.code ?? err.status;
    if (msg.includes('invalid_grant') || status === 400 || status === 401) return true;
    return looksLikeGoogleAuthError(err.cause);
};

/**
 * Marca al usuario para que reconecte Google. Calendar/Drive no lo hacen solos
 * (sí lo hace el middleware HTTP `requireValidGoogleToken`, que el batch no
 * atraviesa), así que el orquestador replica ese marcado (RN-B12).
 */
const markGoogleReconnect = async (userId) => {
    try {
        await prisma.user.update({ where: { id: userId }, data: { googleReconnectRequired: true } });
        logger.warn('scheduler.google.reconnect_marked', { userId });
    } catch (error) {
        logger.error('scheduler.google.mark_reconnect_failed', { userId, message: error.message });
    }
};

/**
 * Sincroniza las fuentes conectadas de un usuario dentro de la ventana dada.
 *
 * @param {object} user - debe traer: id, refreshToken, googleReconnectRequired,
 *   jiraRefreshToken, jiraCloudId, jiraReconnectRequired
 * @param {{ start: Date, end: Date }} window - ventana de la jornada en UTC
 * @returns {Promise<{ totalImported: number, sources: {calendar: ?number, drive: ?number, jira: ?number}, errors: Array<{source:string, message:string}> }>}
 *   `sources.<x>` es el conteo importado, o `null` si la fuente se omitió/falló.
 */
const syncUserActivities = async (user, window) => {
    const startedAt = Date.now();
    const { start, end } = window;
    const sources = { calendar: null, drive: null, jira: null };
    const errors = [];

    logger.info('scheduler.user.start', {
        userId: user.id,
        start: start.toISOString(),
        end: end.toISOString(),
    });

    // —— Google (Calendar + Drive) ——
    if (!user.refreshToken) {
        logger.info('scheduler.source.skipped', { userId: user.id, source: 'google', reason: 'not_connected' });
    } else if (user.googleReconnectRequired) {
        logger.info('scheduler.source.skipped', { userId: user.id, source: 'google', reason: 'reconnect_required' });
    } else {
        let googleToken = null;
        try {
            googleToken = decrypt(user.refreshToken);
        } catch {
            errors.push({ source: 'google', message: 'decrypt_failed' });
            logger.error('scheduler.user.error', { userId: user.id, source: 'google', message: 'decrypt_failed' });
        }

        if (googleToken) {
            let googleAuthFailed = false;

            try {
                const r = await calendarService.persistCalendarActivitiesInWindow(user.id, googleToken, start, end);
                sources.calendar = r.count;
            } catch (error) {
                errors.push({ source: 'calendar', message: error.message });
                logger.error('scheduler.user.error', { userId: user.id, source: 'calendar', message: error.message });
                if (looksLikeGoogleAuthError(error)) googleAuthFailed = true;
            }

            try {
                const r = await driveService.persistDriveActivities(user.id, googleToken, start, end);
                sources.drive = r.count;
            } catch (error) {
                errors.push({ source: 'drive', message: error.message });
                logger.error('scheduler.user.error', { userId: user.id, source: 'drive', message: error.message });
                if (looksLikeGoogleAuthError(error)) googleAuthFailed = true;
            }

            if (googleAuthFailed) {
                await markGoogleReconnect(user.id);
            }
        }
    }

    // —— Jira ——
    if (!user.jiraRefreshToken || !user.jiraCloudId) {
        logger.info('scheduler.source.skipped', { userId: user.id, source: 'jira', reason: 'not_connected' });
    } else if (user.jiraReconnectRequired) {
        logger.info('scheduler.source.skipped', { userId: user.id, source: 'jira', reason: 'reconnect_required' });
    } else {
        try {
            // jira.syncForUser refresca su propio token y ya marca jiraReconnectRequired ante invalid_grant.
            const r = await jiraService.syncForUser(user.id, start, end);
            sources.jira = r.imported;
        } catch (error) {
            errors.push({ source: 'jira', message: error.message });
            logger.error('scheduler.user.error', { userId: user.id, source: 'jira', message: error.message });
        }
    }

    const totalImported = (sources.calendar || 0) + (sources.drive || 0) + (sources.jira || 0);
    const durationMs = Date.now() - startedAt;
    logger.info('scheduler.user.done', { userId: user.id, sources, totalImported, errors: errors.length, durationMs });

    return { totalImported, sources, errors };
};

module.exports = {
    syncUserActivities,
    looksLikeGoogleAuthError,
};
