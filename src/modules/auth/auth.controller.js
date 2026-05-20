const {
  getGoogleAuthUrl,
  handleGoogleCallback,
  InsufficientScopesError,
} = require('./auth.service');
const { UnauthorizedUserError } = require('../users/users.service');
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
      logger.warn('Usuario intentó loguearse sin otorgar todos los permisos');
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=insufficient_scopes`);
    }
    if (error instanceof UnauthorizedUserError) {
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=unauthorized_user`);
    }
    logger.error('Error en Google OAuth callback', { error: error.message });
    res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
  }
};

module.exports = { redirectToGoogle, googleCallback };
