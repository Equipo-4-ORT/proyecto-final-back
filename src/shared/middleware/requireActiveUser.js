const prisma = require('../database/prisma');
const logger = require('../utils/logger');

/**
 * Middleware: verifica contra la base de datos que el usuario autenticado
 * todavía existe y está activo. Debe ejecutarse después de authMiddleware.
 *
 * Refresca `req.user` con los datos vigentes de la BD (incluido el role),
 * para que el contenido del JWT no quede como única fuente de verdad: un token
 * válido podría pertenecer a un usuario ya eliminado, desactivado, o cuyo role
 * cambió desde que se emitió el token.
 */
const requireActiveUser = async (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Unauthorized', message: 'No autenticado' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, fullName: true, role: true, status: true },
    });

    if (!user) {
      logger.warn(`Acceso denegado: el usuario ${req.user.id} del token ya no existe en la BD`);
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'El usuario autenticado ya no existe' });
    }

    if (user.status !== 'ACTIVE') {
      logger.warn(`Acceso denegado: el usuario ${user.id} no está activo`);
      return res.status(403).json({ error: 'Forbidden', message: 'Tu cuenta no está activa' });
    }

    req.user = user;
    return next();
  } catch (error) {
    logger.error('Error al verificar el usuario autenticado', { error });
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'No se pudo verificar el usuario' });
  }
};

module.exports = requireActiveUser;
