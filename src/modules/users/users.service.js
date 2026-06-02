const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

class UnauthorizedUserError extends Error {
  constructor(email) {
    super('Tu cuenta no está habilitada. Contactá al administrador.');
    this.name = 'UnauthorizedUserError';
    this.statusCode = 401;
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

  try {
    const updatedUser = await prisma.user.update({
      where: { email: normalizedEmail },
      data: {
        googleId,
        fullName: fullName || user.fullName,
        ...(encryptedRefreshToken && { refreshToken: encryptedRefreshToken }),
        googleReconnectRequired: false,
      },
    });
    return updatedUser;
  } catch (error) {
    logger.error('Error al actualizar usuario en la BD', { error });
    throw new Error('No se pudo actualizar el usuario', { cause: error });
  }
};

const getUserSettings = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      workStartTime: true,
      workEndTime: true,
      avoidOverlaps: true,
    },
  });

  if (!user) throw new Error('Usuario no encontrado');

  return user;
};

const updateUserSettings = async (userId, settingsData) => {
const { workStartTime, workEndTime, avoidOverlaps } = settingsData;
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/; 

if (workStartTime && !timeRegex.test(workStartTime)) {
  throw new Error('workStartTime debe tener formato HH:mm');
}
if (workEndTime && !timeRegex.test(workEndTime)) {
  throw new Error('workEndTime debe tener formato HH:mm');
}

if (workStartTime && workEndTime) {
  if (workStartTime >= workEndTime) {
    throw new Error('workStartTime debe ser menor que workEndTime');
  }
}

const dataToUpdate = {};
if (workStartTime !== undefined) dataToUpdate.workStartTime = workStartTime;
if (workEndTime !== undefined) dataToUpdate.workEndTime = workEndTime;
if (avoidOverlaps !== undefined) dataToUpdate.avoidOverlaps = avoidOverlaps;

const updatedUser = await prisma.user.update({
  where: { id: userId },
  data: dataToUpdate,
  select: {
    workStartTime: true,
    workEndTime: true,
    avoidOverlaps: true,

  }
});
return updatedUser;
}


module.exports = {
  loginGoogleUser, 
  UnauthorizedUserError,
  getUserSettings,
  updateUserSettings
   };
