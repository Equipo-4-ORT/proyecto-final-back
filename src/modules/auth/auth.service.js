const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { verifyGoogleToken } = require('../google/google.service');
const { upsertGoogleUser } = require('../users/users.service');
const { encrypt } = require('../../shared/utils/crypto');

const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/documents',
];

// Guarda los states válidos en memoria. En prod usar Redis o similar.
const pendingStates = new Set();

const getGoogleAuthUrl = () => {
    const state = randomBytes(16).toString('hex');
    pendingStates.add(state);
    // Limpia el state después de 10 minutos
    setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

    return client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        state,
    });
};

const handleGoogleCallback = async (code, state) => {
    if (!state || !pendingStates.has(state)) {
        throw new Error('State inválido o expirado');
    }
    pendingStates.delete(state);

    const { tokens } = await client.getToken(code);
    const googleData = await verifyGoogleToken(tokens.id_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const user = await upsertGoogleUser(googleData, encryptedRefreshToken);
    return generateJWT(user);
};

const generateJWT = (user) => {
    return jwt.sign(
        { sub: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
};

module.exports = { getGoogleAuthUrl, handleGoogleCallback, generateJWT };
