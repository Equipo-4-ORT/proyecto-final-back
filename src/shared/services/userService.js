const prisma = require('../database/prisma');

/**
 * Busca un usuario por email. Si existe, actualiza sus datos de Google.
 * Si no existe, lo crea asignándole un rol según su dominio.
 * * @param {Object} googleData - Objeto devuelto por verifyGoogleIdToken
 * @returns {Object} - El usuario guardado en PostgreSQL
 */

async function upsertGoogleUser(googleData) {
    const { email, googleId, fullName } = googleData;

    //let assignedRole = 'USER';
    //if (email.endsWith('@finnegans.com.ar')) {
    //    assignedRole = 'EMPLOYEE';
    //}

    try {
        const user = await prisma.user.upsert({
            where:
                { email: email },
            update: {
                googleId: googleId,
                fullName: fullName
            },
            create: {
                email: email,
                googleId: googleId,
                fullName: fullName,
                //role: assignedRole // por ahora usaremos el default de prisma ya que todavia no estamos seguros de la logica de asignacion de roles
            }
        });
        return user;
    } catch (error) {
        console.error('Error al crear o actualizar usuario:', error);
        throw new Error('No se pudo guardar el usuario en la base de datos');;
    }
}

module.exports = {
    upsertGoogleUser
};