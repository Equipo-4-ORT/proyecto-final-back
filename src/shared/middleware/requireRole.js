const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Unauthorized', message: 'No autenticado' });
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