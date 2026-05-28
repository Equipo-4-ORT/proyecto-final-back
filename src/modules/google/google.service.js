const { OAuth2Client } = require('google-auth-library');
const logger = require('../../shared/utils/logger');

if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is required');
}

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
 * Devuelve un OAuth2Client autenticado con el refresh token ya descifrado.
 * El llamador (controller) es responsable de obtener y descifrar el token.
 * @param {string} refreshToken - Refresh token descifrado del usuario
 */
const getAuthenticatedGoogleClient = (refreshToken) => {
    if (!refreshToken) {
        throw new Error('Refresh token requerido para obtener cliente autenticado');
    }
    const oauth2Client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
};

module.exports = {
    verifyGoogleToken,
    getAuthenticatedGoogleClient,
};
