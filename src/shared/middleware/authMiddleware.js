const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');


const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({error: 'No autorizado', message: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role
        }
        next();
    } catch (error) {
        logger.error('Token inválido o expirado', { error });
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                error: 'Token expirado', 
                message: 'El token ha caducado, por favor solicita uno nuevo.'
             });
        }
        return res.status(401).json({
            error: 'Token inválido', 
            message: 'La autenticación ha fallado.' });
    }
};

module.exports = authMiddleware;
