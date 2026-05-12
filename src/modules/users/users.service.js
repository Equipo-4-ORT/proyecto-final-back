const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { asignarRol } = require('../auth/auth.service');

/**
 * Busca un usuario por email. Si existe, actualiza sus datos de Google.
  * Si no existe, lo crea con el rol asignado según la llave de admin.
 * @param {Object} googleData - Objeto devuelto por verifyGoogleToken
 * @returns {Object} - El usuario guardado en PostgreSQL
 */
const upsertGoogleUser = async (googleData, adminKey) => {
    const { email, googleId, fullName } = googleData;

    if (!email || !googleId) {
        throw new Error('upsertGoogleUser: email y googleId son requeridos');
    }

    // Postgres trata el unique como case-sensitive: normalizar evita duplicar usuarios por casing
    const normalizedEmail = email.toLowerCase().trim();


    try {
        const role = asignarRol(adminKey);
        const user = await prisma.user.upsert({
            where: { email: normalizedEmail },
            update: {
                googleId,
                fullName
            },
            create: {
                email: normalizedEmail,
                googleId,
                fullName,
                role
            }
        });
        return user;
    } catch (error) {
        logger.error('Error al crear o actualizar usuario', { error });
        throw new Error('No se pudo guardar el usuario en la base de datos', { cause: error });
    }
};

module.exports = {
    upsertGoogleUser
};
