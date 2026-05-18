const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const logger = require('../../shared/utils/logger');
const prisma = require('../../shared/database/prisma');
const { verifyGoogleToken } = require('../google/google.service');
const { upsertGoogleUser } = require('../users/users.service');
const { encrypt } = require('../../shared/utils/crypto');

if (!process.env.ADMIN_SECRET_KEY) {
  throw new Error('ADMIN_SECRET_KEY environment variable is required');
}

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
];

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
];

const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const ADMIN_KEY_HEADER = process.env.ADMIN_KEY_HEADER || 'X-Admin-Key';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

class InvalidAdminKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAdminKeyError';
  }
}

class InsufficientScopesError extends Error {
  constructor() {
    super('El usuario no otorgó todos los permisos requeridos');
    this.name = 'InsufficientScopesError';
  }
}

const getGoogleAuthUrl = async () => {
  const state = randomBytes(16).toString('hex');
  await prisma.googleOAuthState.create({
    data: {
      state,
      expiresAt: new Date(Date.now() + GOOGLE_OAUTH_STATE_TTL_MS),
    },
  });

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
};

const generateJWT = (user) => {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
};

const handleGoogleCallback = async (code, state) => {
  const stored = state ? await prisma.googleOAuthState.findUnique({ where: { state } }) : null;
  if (!stored || stored.expiresAt.getTime() < Date.now()) {
    if (stored) await prisma.googleOAuthState.delete({ where: { state } }).catch(() => {});
    throw new Error('State inválido o expirado');
  }
  await prisma.googleOAuthState.delete({ where: { state } }).catch(() => {});

  const { tokens } = await client.getToken(code);
  const grantedScopes = (tokens.scope || '').split(' ');
  const missingScopes = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s));
  if (missingScopes.length > 0) {
    throw new InsufficientScopesError();
  }

  const googleData = await verifyGoogleToken(tokens.id_token);
  const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const user = await upsertGoogleUser(googleData, encryptedRefreshToken);
  return generateJWT(user);
};

const asignarRol = (adminKey) => {
  if (!adminKey) {
    logger.info('No se proporcionó llave del admin. Rol asignado: EMPLOYEE');
    return 'EMPLOYEE';
  }

  if (adminKey === ADMIN_SECRET_KEY) {
    logger.info('Llave de admin válida. Rol asignado: ADMIN');
    return 'ADMIN';
  }

  logger.warn('Llave de admin inválida intentada');
  throw new InvalidAdminKeyError('Llave de admin inválida');
};

module.exports = {
  asignarRol,
  InvalidAdminKeyError,
  InsufficientScopesError,
  ADMIN_KEY_HEADER,
  getGoogleAuthUrl,
  handleGoogleCallback,
  generateJWT,
};
