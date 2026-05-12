const logger = require('../../shared/utils/logger');

const ADMIN_KEY_HEADER = process.env.ADMIN_KEY_HEADER || 'X-Admin-Key';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'admin-secret-key-default';

/**
 * Valida la llave del admin y determina el rol
 * @param {string} adminKey - Llave recibida en el header (puede ser undefined)
 * @returns {string} - 'ADMIN' o 'EMPLOYEE'
 * @throws {Error} - Si la llave es inválida
 */

const asignarRol = (adminKey) => {
    if (!adminKey) {
        logger.info('No se proporcionó llave del admin. Rol asignado: EMPLOYEE')
        return 'EMPLOYEE'
    }

    if (adminKey === ADMIN_SECRET_KEY) {
        logger.info('Llave de admin válida. Rol asignado: ADMIN')
        return 'ADMIN'
    }

    logger.warn('Llave de admin inválida intentada')
    throw new Error('Llave de admin inválida')
}

module.exports = {
    asignarRol,
    ADMIN_KEY_HEADER
}