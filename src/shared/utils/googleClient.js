const { OAuth2Client } = require('google-auth-library');
const { decrypt } = require('./crypto');
const prisma = require('../database/prisma');

/**
 * Devuelve un OAuth2Client autenticado con el refresh token del usuario.
 * Usarlo para llamar Google Calendar, Sheets, Docs, etc.
 * @param {string} userId - El id del usuario (req.user.sub desde el JWT)
 */
const getGoogleClientForUser = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user?.refreshToken) {
    throw new Error('El usuario no tiene refresh token almacenado');
  }

  const refreshToken = decrypt(user.refreshToken);

  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  client.setCredentials({ refresh_token: refreshToken });
  return client;
};

module.exports = { getGoogleClientForUser };
