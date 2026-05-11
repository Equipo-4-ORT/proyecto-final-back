const { OAuth2Client } = require('google-auth-library');
const logger = require('../../shared/utils/logger');
const { decrypt } = require('dotenv');

if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is required');
}

const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);

/**
 * Verifica la firma de un ID Token de Google y extrae la información del usuario
 * @param {string} token - El ID token enviado desde el frontend
 * @returns {object} - Los datos del usuario (claims)
 */
const verifyGoogleToken = async (token) => {
    if (!token || typeof token !== 'string') {
        throw new Error('Token requerido');
    }

    let payload;
    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        payload = ticket.getPayload();
    } catch (error) {
        logger.error('Error verifying Google token', { error });
        throw new Error('Invalid Google token', { cause: error });
    }

    if (!payload.email_verified) {
        throw new Error('Email no verificado por Google');
    }

    // TODO: validar dominio de email (ej: solo @finnegans.com.ar) cuando se defina la regla de negocio

    return {
        googleId: payload['sub'],
        email: payload['email'],
        fullName: payload['name'],
        picture: payload['picture'],
        emailVerified: payload['email_verified']
    };
};

/**
 * Pide un nuevo access_token a Google usando el refresh_token desencriptado.
 * @param {string} encryptedRefreshToken - El token encriptado guardado en Prisma
 * @returns {string} - El nuevo access_token de Google (válido por 1 hora)
 */
const refreshGoogleAccessToken = async (encryptedRefreshToken) => {
    if (!encryptedRefreshToken) {
        throw new Error('Refresh token requerido');
    }
    try {
        const decryptedToken = decrypt(encryptedRefreshToken);
        client.setCredentials({ refresh_token: decryptedToken });
        const { credentials } = await client.refreshAccessToken();
        return credentials.access_token;
    } catch (error) {
        logger.error('Error refreshing Google access token', { error });
        throw new Error('Failed to refresh Google access token', { cause: error });
    }
};

module.exports = {
    verifyGoogleToken,
    refreshGoogleAccessToken
};
