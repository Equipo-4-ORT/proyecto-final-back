const { OAuth2Client } = require('google-auth-library');
const prisma = require('../database/prisma');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);

const requireValidGoogleToken = async (req, res, next) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Usuario no autenticado' });
        }

        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { refreshToken: true },
        });

        if (!user || !user.refreshToken) {
            return res.status(401).json({
                error: 'Usuario no autenticado',
                message: 'Debes conectar tu cuenta de Google para usar esta funcion. '
            });
        }

        const refreshToken = decrypt(user.refreshToken);

        googleClient.setCredentials({ refresh_token: refreshToken });

        await googleClient.getAccessToken();

        next();

    } catch (error) {
        logger.warn(`Error validando refresh token de google para user ${req.user.id}: ${error.message}`);
        if (error.message.includes('invalid_grant') || error.response?.status === 400 || error.response?.status === 401) {
            return res.status(401).json({
                error: 'google_auth_required',
                message: 'La conexión con Google ha expirado o fue revocada. Por favor, vuelve a reconectar tu cuenta.'
            });
        }
        next(error);
    }
};

module.exports = requireValidGoogleToken;
