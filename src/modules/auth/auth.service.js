const logger = require('../../shared/utils/logger');

if (!process.env.ADMIN_SECRET_KEY) {
    throw new Error('ADMIN_SECRET_KEY environment variable is required');
}

const ADMIN_KEY_HEADER = process.env.ADMIN_KEY_HEADER || 'X-Admin-Key';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

class InvalidAdminKeyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidAdminKeyError';
    }
}

const asignarRol = (adminKey) => {
    if (!adminKey) {
        logger.info('No se proporcionó llave del admin. Rol asignado: EMPLOYEE');
        return 'EMPLOYEE';
    }

    if (adminKey === ADMIN_SECRET_KEY) {
        logger.info('Llave de admin válida. Rol asignado: ADMIN');
        return 'ADMIN';
    }

    logger.warn('Llave de admin inválida intentada');
    throw new InvalidAdminKeyError('Llave de admin inválida');
};

module.exports = {
    asignarRol,
    InvalidAdminKeyError,
    ADMIN_KEY_HEADER,
};
