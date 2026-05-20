const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

class UnauthorizedUserError extends Error {
  constructor(email) {
    super('Tu cuenta no está habilitada. Contactá al administrador.');
    this.name = 'UnauthorizedUserError';
    this.email = email;
  }
}

/**
 * Verifica que el usuario exista y esté activo (pre-registrado por el admin).
 * Si existe, actualiza su googleId y refreshToken. Si no existe, rechaza el login.
 */
const loginGoogleUser = async (googleData, encryptedRefreshToken = null) => {
  const { email, googleId, fullName } = googleData;

  if (!email || !googleId) {
    throw new Error('loginGoogleUser: email y googleId son requeridos');
  }

  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user || user.status !== 'ACTIVE') {
    logger.warn('Intento de login de usuario no autorizado', { email: normalizedEmail });
    throw new UnauthorizedUserError(normalizedEmail);
  }

  const updatedUser = await prisma.user.update({
    where: { email: normalizedEmail },
    data: {
      googleId,
      fullName: fullName || user.fullName,
      ...(encryptedRefreshToken && { refreshToken: encryptedRefreshToken }),
    },
  });

  return updatedUser;
};

module.exports = { loginGoogleUser, UnauthorizedUserError };
