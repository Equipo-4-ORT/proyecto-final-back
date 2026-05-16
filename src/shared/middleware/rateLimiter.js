const rateLimit = require('express-rate-limit');

const createAuthLimiter = (options = {}) =>
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Demasiados intentos. Intentá de nuevo en 15 minutos.' },
        ...options,
    });

const createApiLimiter = (options = {}) =>
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 200,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Límite de requests alcanzado. Intentá de nuevo en 15 minutos.' },
        ...options,
    });

const authLimiter = createAuthLimiter();
const apiLimiter = createApiLimiter();

module.exports = { authLimiter, apiLimiter, createAuthLimiter, createApiLimiter };
