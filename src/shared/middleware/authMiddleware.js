const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Alias temporal: aceptamos JWT_SECRET hasta sacarlo en el próximo release.
const getAccessSecret = () => process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;

const authMiddleware = (req, res, next) => {
  // El access token viaja en una cookie HttpOnly (antes: header Authorization).
  const token = req.cookies?.access_token;
  if (!token) {
    return res.status(401).json({ error: 'No autorizado', message: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, getAccessSecret());
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch (error) {
    logger.error('Token inválido o expirado', { error });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirado',
        message: 'El token ha caducado, por favor solicita uno nuevo.',
      });
    }
    return res.status(401).json({
      error: 'Token inválido',
      message: 'La autenticación ha fallado.',
    });
  }
};

module.exports = authMiddleware;
