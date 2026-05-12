const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        // TODO: Depende de F1-05.1 (requireAuth middleware)
        // Se asume que req.user está adjuntado por requireAuth
        if (!req.user) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Token requerido'
            });
        }
        const userRole = req.user.role;
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: `Acceso denegado. Se requiere uno de los roles: ${allowedRoles.join(', ')}`
            });
        }
        next();
    };
};

module.exports = requireRole;