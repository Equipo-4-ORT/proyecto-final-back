const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { asignarRol, InvalidAdminKeyError } = require('../auth/auth.service');
const { encrypt } = require('../../shared/utils/crypto');

/**
 * Busca un usuario por email. Si existe, actualiza sus datos de Google.
 * Si no existe, lo crea con el rol asignado según la llave de admin.
 * @param {Object} googleData - Objeto devuelto por verifyGoogleToken
 * @param {string} googleData.email - Email del usuario
 * @param {string} googleData.googleId - ID de Google
 * @param {string} googleData.fullName - Nombre completo
 * @param {string} [googleData.refreshToken] - Token de refresco de Google (opcional)
 * @param {string} adminKey - Llave de admin para determinar rol
 * @returns {Object} - El usuario guardado en PostgreSQL
 */
const upsertGoogleUser = async (googleData, adminKey) => {
    const { email, googleId, fullName, refreshToken } = googleData;

    if (!email || !googleId) {
        throw new Error('upsertGoogleUser: email y googleId son requeridos');
    }

    // Postgres trata el unique como case-sensitive: normalizar evita duplicar usuarios por casing
    const normalizedEmail = email.toLowerCase().trim();

    try {
        const role = asignarRol(adminKey);
        
        // Encriptar refreshToken si está presente
        const encryptedRefreshToken = refreshToken ? encrypt(refreshToken) : null;
        
        const user = await prisma.user.upsert({
            where: { email: normalizedEmail },
            update: {
                googleId,
                fullName,
                ...(encryptedRefreshToken && { refreshToken: encryptedRefreshToken })
            },
            create: {
                email: normalizedEmail,
                googleId,
                fullName,
                role,
                refreshToken: encryptedRefreshToken
            }
        });
        return user;
    } catch (error) {
        if (error instanceof InvalidAdminKeyError) {
            throw error;
        }
        // Si es error de BD, lo envuelve
        logger.error('Error al crear o actualizar usuario', { error });
        throw new Error('No se pudo guardar el usuario en la base de datos', { cause: error });
    }
};

module.exports = {
    upsertGoogleUser
};
