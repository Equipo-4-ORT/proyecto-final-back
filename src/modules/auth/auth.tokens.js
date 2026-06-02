/**
 * Helpers de tokens de sesión (auth por cookies HttpOnly).
 *
 * - Access token: JWT corto (15 min por defecto) con { sub, email, role }.
 * - Refresh token: opaco (32 bytes aleatorios, NO es JWT). En la DB se guarda
 *   SOLO su hash SHA-256 (Session.refreshTokenHash); el valor plano vive
 *   únicamente en la cookie HttpOnly del browser.
 *
 * El secret se lee dentro de cada función (no a nivel de módulo) para respetar
 * la configuración por entorno y facilitar los tests.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const REFRESH_TTL_DAYS = 7;

// Alias temporal: aceptamos JWT_SECRET hasta sacarlo en el próximo release.
const getAccessSecret = () => process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const getAccessTtl = () => process.env.JWT_ACCESS_TTL || '15m';

const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email, role: user.role }, getAccessSecret(), {
    expiresIn: getAccessTtl(),
  });

const verifyAccessToken = (token) => jwt.verify(token, getAccessSecret());

// Refresh token opaco. node:crypto (NUNCA Math.random) por requisito de seguridad.
const generateRefreshToken = () => crypto.randomBytes(32).toString('base64url');

// SHA-256 alcanza: el token ya tiene alta entropía (32 bytes aleatorios).
// bcrypt es para passwords (baja entropía), no para tokens random.
const hashRefreshToken = (plain) => crypto.createHash('sha256').update(plain).digest('hex');

const refreshExpiresAt = () => new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiresAt,
  REFRESH_TTL_DAYS,
};
