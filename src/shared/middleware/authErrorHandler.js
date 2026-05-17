const authErrorHandler = (err, req, res, next) => {
  if (
    err.name === 'UnauthorizedError' ||
    err.name === 'JsonWebTokenError' ||
    err.name === 'TokenExpiredError'
  ) {
    err.status = 401;

    if (err.name === 'TokenExpiredError') {
      err.message = 'Token expirado, por favor solicite uno nuevo.';
    } else if (err.name === 'JsonWebTokenError') {
      err.message = 'Token inválido o mal formado, por favor inicia sesión nuevamente.';
    } else {
      err.message = 'No autorizado, por favor inicia sesión.';
    }

    return next(err);
  }

  if (err.status === 403 || err.name === 'ForbiddenError') {
    err.status = 403;
    err.message = err.message || `Acceso denegado. No tienes permisos para acceder a este recurso.`;
    return next(err);
  }

  next(err);
};

module.exports = authErrorHandler;
