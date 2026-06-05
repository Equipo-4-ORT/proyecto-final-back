const prisma = require('../database/prisma');
const { decrypt } = require('./crypto');

/**
 * Busca el refresh token de Google del usuario y lo descifra.
 * Centraliza el lookup + decrypt que comparten los controllers de sincronización
 * (Calendar, Drive, etc.) para no duplicar la lógica ni el manejo del token.
 * @param {string} userId - id del usuario (req.user.id, viene del JWT)
 * @returns {Promise<string|null>} token descifrado, o null si el usuario no existe o no tiene token
 */
const getDecryptedRefreshToken = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { refreshToken: true },
  });

  if (!user || !user.refreshToken) {
    return null;
  }

  return decrypt(user.refreshToken);
};

module.exports = { getDecryptedRefreshToken };
