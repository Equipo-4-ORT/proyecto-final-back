const {
  getGoogleAuthUrl,
  handleGoogleCallback,
  InsufficientScopesError,
} = require('./auth.service');
const logger = require('../../shared/utils/logger');

const redirectToGoogle = (req, res) => {
  const url = getGoogleAuthUrl();
  res.redirect(url);
};

const googleCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    const frontendUrl = process.env.FRONTEND_URL;

    if (error === 'access_denied') {
      return frontendUrl 
      ? res.redirect(`${frontendUrl}/login?error=access_denied`)
        : res.status(403).json({ debug_mode: true, error: 'Acceso denegado por el usuario' });
    }
    if (!code) {
     return frontendUrl 
        ? res.redirect(`${frontendUrl}/login?error=missing_code`)
        : res.status(400).json({ debug_mode: true, error: 'Falta el código de Google' });
    }

    const token = await handleGoogleCallback(code, state);
  if (frontendUrl) {
      // Flujo normal de Producción/Integración
      res.redirect(`${frontendUrl}/callback?token=${token}`);
    } else {
      // Flujo de Debug Local (Para usar en Postman)
      res.status(200).json({
        debug_mode: true,
        mensaje: "¡Login Exitoso! Como FRONTEND_URL no está definido, devolvemos el token aquí.",
        tu_jwt_para_postman: token
      });
    }
  } catch (error) {
 const frontendUrl = process.env.FRONTEND_URL;
    
    if (error instanceof InsufficientScopesError) {
      logger.warn('Usuario intentó loguearse sin otorgar todos los permisos');
      return frontendUrl 
        ? res.redirect(`${frontendUrl}/login?error=insufficient_scopes`)
        : res.status(403).json({ debug_mode: true, error: 'Faltan permisos de Google' });
    }
    
    logger.error('Error en Google OAuth callback', { error: error.message });
    return frontendUrl 
      ? res.redirect(`${frontendUrl}/login?error=auth_failed`)
      : res.status(500).json({ debug_mode: true, error: 'Falló la autenticación', detalle: error.message });
  }
};


module.exports = { redirectToGoogle, googleCallback };
