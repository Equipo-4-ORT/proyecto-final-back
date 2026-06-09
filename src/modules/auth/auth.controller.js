const {
  getGoogleAuthUrl,
  handleGoogleCallback,
  InsufficientScopesError,
  UserNotActiveError,
  InvalidAdminKeyError,
  AdminAlreadyExistsError,
  bootstrapAdmin,
} = require('./auth.service');
const { UnauthorizedUserError } = require('../users/users.service');
const tokensHelper = require('./auth.tokens');
const cookiesHelper = require('./auth.cookies');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

// Destino en el front según el rol del usuario. El backend es quien decide
// a dónde va cada rol; el front solo lee el parámetro y lo valida.
const ROLE_DESTINATIONS = {
  ADMIN:    '/admin',
  EMPLOYEE: '/dashboard',
};
const DEFAULT_DESTINATION = '/dashboard';

const redirectToGoogle = (req, res) => {
  const url = getGoogleAuthUrl();
  res.redirect(url);
};

const googleCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error === 'access_denied') {
      return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=access_denied`);
    }
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=missing_code`);
    }

    // handleGoogleCallback ahora devuelve el `user` (no el JWT).
    const user = await handleGoogleCallback(code, state);

    // Crear sesión + refresh token rotativo. Guardamos SOLO el hash del refresh.
    const refreshPlain = tokensHelper.generateRefreshToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: tokensHelper.hashRefreshToken(refreshPlain),
        userAgent: req.get('user-agent'),
        ip: req.ip,
        expiresAt: tokensHelper.refreshExpiresAt(),
      },
    });

    cookiesHelper.setAccessCookie(res, tokensHelper.signAccessToken(user));
    cookiesHelper.setRefreshCookie(res, refreshPlain);

    // El backend indica al front a dónde redirigir según el rol.
    // Sin ?token= en la URL: el JWT viaja solo en la cookie HttpOnly.
    const destination = ROLE_DESTINATIONS[user.role] ?? DEFAULT_DESTINATION;
    return res.redirect(`${process.env.FRONTEND_BASE_URL}/callback?redirect=${destination}`);
  } catch (error) {
    if (error instanceof InsufficientScopesError) {
      logger.warn('Usuario intentó loguearse sin otorgar todos los permisos');
      return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=insufficient_scopes`);
    }
    if (error instanceof UserNotActiveError) {
      logger.warn('Intento de login denegado: el usuario no está activo');
      return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=user_not_active`);
    }
    if (error instanceof UnauthorizedUserError) {
      return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=unauthorized_user`);
    }
    logger.error('Error en Google OAuth callback', { error: error.message });
    return res.redirect(`${process.env.FRONTEND_BASE_URL}/login?error=auth_failed`);
  }
};

const refresh = async (req, res) => {
  const refreshPlain = req.cookies?.refresh_token;
  if (!refreshPlain) {
    return res.status(401).json({ error: 'no_refresh' });
  }

  const hash = tokensHelper.hashRefreshToken(refreshPlain);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    // Reuse detection: si vuelve a aparecer un refresh ya revocado → señal de robo.
    // Mata todas las sesiones activas del usuario.
    if (session && session.revokedAt) {
      await prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      logger.warn('Refresh token reuse detectado — revocando todas las sesiones', {
        userId: session.userId,
      });
    }
    cookiesHelper.clearAuthCookies(res);
    return res.status(401).json({ error: 'invalid_refresh' });
  }

  // Mismo criterio que requireActiveUser: el user tiene que seguir ACTIVE.
  if (session.user.status !== 'ACTIVE') {
    cookiesHelper.clearAuthCookies(res);
    return res.status(403).json({ error: 'user_not_active' });
  }

  // Rotación: revoco el actual y emito uno nuevo, en una sola transacción.
  const newRefreshPlain = tokensHelper.generateRefreshToken();
  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    }),
    prisma.session.create({
      data: {
        userId: session.userId,
        refreshTokenHash: tokensHelper.hashRefreshToken(newRefreshPlain),
        userAgent: req.get('user-agent'),
        ip: req.ip,
        expiresAt: tokensHelper.refreshExpiresAt(),
      },
    }),
  ]);

  cookiesHelper.setAccessCookie(res, tokensHelper.signAccessToken(session.user));
  cookiesHelper.setRefreshCookie(res, newRefreshPlain);
  return res.json({ ok: true });
};

const logout = async (req, res) => {
  const refreshPlain = req.cookies?.refresh_token;
  if (refreshPlain) {
    await prisma.session.updateMany({
      where: {
        refreshTokenHash: tokensHelper.hashRefreshToken(refreshPlain),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
  cookiesHelper.clearAuthCookies(res);
  return res.json({ ok: true });
};

const me = async (req, res) => {
  // req.user lo setea authMiddleware (cookie) y lo REFRESCA requireActiveUser (DB):
  // role/status acá reflejan el estado real, no el del token (que vive 15 min).
  return res.json({ user: req.user });
};

const createBootstrapAdmin = async (req, res) => {
  try {
    const adminKey = req.header('X-Admin-Key');
    const { email, fullName } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'El campo email es requerido' });
    }
    const newAdmin = await bootstrapAdmin(email, fullName, adminKey);
    return res.status(201).json({
      message: 'Administrador maestro creado con éxito',
      admin: {
        id: newAdmin.id,
        email: newAdmin.email,
        role: newAdmin.role,
      },
    });
  } catch (error) {
    if (error instanceof InvalidAdminKeyError) {
      return res.status(401).json({ error: 'Llave de admin inválida' });
    }
    if (error instanceof AdminAlreadyExistsError) {
      return res.status(409).json({ error: 'Ya existe un usuario con rol ADMIN' });
    }
    logger.error('Error al crear el administrador maestro', { error: error.message });
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = {
  redirectToGoogle,
  googleCallback,
  refresh,
  logout,
  me,
  createBootstrapAdmin,
};
