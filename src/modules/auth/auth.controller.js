const {
  getGoogleAuthUrl,
  handleGoogleCallback,
  InsufficientScopesError,
  UserNotActiveError,
  InvalidAdminKeyError,
  AdminAlreadyExistsError,
  bootstrapAdmin,
} = require('./auth.service');
const logger = require('../../shared/utils/logger');

const redirectToGoogle = (req, res) => {
  const url = getGoogleAuthUrl();
  res.redirect(url);
};

const googleCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error === 'access_denied') {
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=access_denied`);
    }
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=missing_code`);
    }

    const token = await handleGoogleCallback(code, state);
    res.redirect(`${process.env.FRONTEND_URL}/callback?token=${token}`);
  } catch (error) {
    if (error instanceof InsufficientScopesError) {
      // ← acá va
      logger.warn('Usuario intentó loguearse sin otorgar todos los permisos');
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=insufficient_scopes`);
    }
    if (error instanceof UserNotActiveError) {
      logger.warn('Intento de login denegado: el usuario no está activo');
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=user_not_active`);
    }
    logger.error('Error en Google OAuth callback', { error: error.message });
    res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
  }
};

const createBootstrapAdmin = async (req, res) => {
  try {
    const adminKey = req.header('X-Admin-Key');
    const {email, fullName} = req.body;
      if (!email){
        return res.status(400).json({ error: 'El campo email es requerido' });
      }
      const newAdmin = await bootstrapAdmin(email, fullName, adminKey);
      return res.status(201).json({
      message: 'Administrador maestro creado con éxito',
      admin: {
        id: newAdmin.id,
        email: newAdmin.email,
        role: newAdmin.role
      }
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

module.exports = { redirectToGoogle, googleCallback, createBootstrapAdmin };
