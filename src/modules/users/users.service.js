const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

class UserValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserValidationError';
    this.statusCode = 400; // <-- [Solución 1] Le adjuntamos el código HTTP
  }
}

class UserNotFoundError extends Error {
  constructor() {
    super('Usuario no encontrado');
    this.name = 'UserNotFoundError';
    this.statusCode = 404;
  }
}

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
      defaultDuration: true,
    },
  });

  if (!user) throw new UserNotFoundError();

  return user;
};

const updateUserSettings = async (userId, settingsData) => {
  const { workStartTime, workEndTime, avoidOverlaps, defaultDuration } = settingsData;
  const dataToUpdate = {};
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

  if (workStartTime !== undefined) {
    if (!timeRegex.test(workStartTime)) {
      throw new UserValidationError('Formato de hora de inicio inválido. Debe ser HH:MM.');
    }
    dataToUpdate.workStartTime = workStartTime;
  }
  if (workEndTime !== undefined) {
    if (!timeRegex.test(workEndTime)) {
      throw new UserValidationError('Formato de hora de fin inválido. Debe ser HH:MM.');
    }
    dataToUpdate.workEndTime = workEndTime;
  }

  // No comparamos inicio vs fin: una jornada puede cruzar la medianoche
  // (ej. turno nocturno 21:00 -> 02:00), así que fin < inicio es válido.

  if (avoidOverlaps !== undefined) {
    if (typeof avoidOverlaps !== 'boolean') {
      throw new UserValidationError('El campo avoidOverlaps debe ser un valor booleano (true o false).');
    }
    dataToUpdate.avoidOverlaps = avoidOverlaps;
  }
  if (defaultDuration !== undefined) {
    if (!Number.isInteger(defaultDuration) || defaultDuration <= 0 || defaultDuration > 180) {
      throw new UserValidationError('La duración por defecto debe ser un número entero de minutos entre 1 y 180.');
    }
    dataToUpdate.defaultDuration = defaultDuration;
  }

  if (Object.keys(dataToUpdate).length === 0) {
    throw new UserValidationError('No se enviaron campos válidos para actualizar.');
  }
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: dataToUpdate,
    select: {
      workStartTime: true,
      workEndTime: true,
      avoidOverlaps: true,
      defaultDuration: true,
    }
  });

  return updatedUser;
};


module.exports = {
  loginGoogleUser,
  UnauthorizedUserError,
  getUserSettings,
  updateUserSettings,
  UserValidationError,
  UserNotFoundError,
};
