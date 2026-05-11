const { Role } = require('@prisma/client');
const jwt = require('jsonwebtoken');

/**
 * Genera un token JWT firmado por nuestro backend.
 * @param {Object} user - El objeto de usuario devuelto por Prisma
 * @returns {string} - El token JWT firmado
 */

function generateToken(user) {
    const payload = {
        id: user.id,
        email: user.email,
        Role: user.Role
    };

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET no está definido en las variables de entorno');
    }

    return jwt.sign(payload, secret, { expiresIn: '8h' });
}

module.exports = {
    generateToken,
};