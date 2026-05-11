const { verifyGoogleToken, refreshGoogleAccessToken } = require('../google/google.service');
const { upsertGoogleUser } = require('../users/users.service');
const { generateToken } = require('../../shared/utils/jwt');
const prisma = require('../../shared/database/prisma');
const { log } = require('winston');

const loginWithGoogle = (req, res) => {
    const url = getGoogleAuthUrl();
    res.redirect(url);
};

const googleCallback = async (req, res, next) => {
     const code = req.query.code;
        if (!code) {
            return res.status(400).json({ error: 'Código de autorización no proporcionado' });
        }
        
    try { const googleData = await getUserDataFromCode(code);

        // Guardamos o actualizamos en nuestra DB (usando tu service existente)
        const user = await upsertGoogleUser(googleData);

        // Generamos nuestro JWT con el payload pedido (id, email, role)
        const token = generateToken(user);

        // Redirigimos al puerto 5173 del front como pidieron
        const frontCallbackUrl = `http://localhost:5173/callback?token=${token}`;
        res.redirect(frontCallbackUrl);

    } catch (error) {
        next(error); // Tu errorHandler se encarga
    }
};
       

async function googleLoginCallback(req, res, next) {
    try {
        const googleToken = req.body.token || req.query.token;
        if (!googleToken) {
            return res.status(400).json({ error: 'Token de Google no proporcionado' });
        }

        const googleData = await verifyGoogleToken(googleToken);

        const user = await upsertGoogleUser(googleData);

        const jwtToken = generateToken(user);

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

        res.redirect(`${frontendUrl}/auth/callback?token=${jwtToken}`);

    } catch (error) {
        console.error(' Error en el flujo de login: ', error);
        next(error);

    }


}

async function refreshTokenCallBack(req, res, next) {
    try {
        const {userId} = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId es requerido' });
        }
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || !user.refreshToken) {
            return res.status(404).json({ error: 'Usuario no encontrado o sin token de refresco' });
        }
        const newAccessToken = await refreshGoogleAccessToken(user.refreshToken);

        res.status(200).json({ 
            message: 'Token de acceso actualizado exitosamente',
            accessToken: newAccessToken
        })
    } catch (error) {
        console.error('Error al actualizar el token de acceso:', error);
        res.status(500).json({ error: 'Error al actualizar el token de acceso' });
    }
}

module.exports = {
    googleLoginCallback,
    refreshTokenCallBack,
    loginWithGoogle,
    googleCallback
};