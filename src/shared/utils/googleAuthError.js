/**
 * Helpers compartidos para manejar fallos de autenticación de Google (token
 * revocado/expirado). Extraídos del orquestador del batch para reusarlos también
 * en la generación on-demand del Sheet del reporte (ver SPEC-TEC reporte-excel-drive §13.6).
 */

const prisma = require('../database/prisma');
const logger = require('./logger');

/**
 * Detecta si un error (o su cadena de `cause`) parece un fallo de autenticación de
 * Google: `invalid_grant` o status 400/401. Calendar/Drive (y la Sheets API)
 * envuelven el error original en `error.cause`, por eso se recorre la cadena.
 * @param {unknown} err
 * @returns {boolean}
 */
const looksLikeGoogleAuthError = (err) => {
    if (!err) return false;
    const msg = String(err.message || '');
    const status = err.response?.status ?? err.code ?? err.status;
    if (msg.includes('invalid_grant') || status === 400 || status === 401) return true;
    return looksLikeGoogleAuthError(err.cause);
};

/**
 * Marca al usuario para que reconecte Google. Best-effort: si la escritura en BD
 * falla, loguea y no propaga (no debe tumbar el flujo que lo invoca).
 * @param {string} userId
 */
const markGoogleReconnect = async (userId) => {
    try {
        await prisma.user.update({ where: { id: userId }, data: { googleReconnectRequired: true } });
        logger.warn('google.reconnect_marked', { userId });
    } catch (error) {
        logger.error('google.mark_reconnect_failed', { userId, message: error.message });
    }
};

module.exports = { looksLikeGoogleAuthError, markGoogleReconnect };
