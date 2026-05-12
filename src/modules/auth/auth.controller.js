const { getGoogleAuthUrl, handleGoogleCallback } = require('./auth.service');
const logger = require('../../shared/utils/logger');

const redirectToGoogle = (req, res) => {
    const url = getGoogleAuthUrl();
    res.redirect(url);
};

const googleCallback = async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code) {
            return res.redirect(`${process.env.FRONTEND_URL}/login?error=missing_code`);
        }
        const token = await handleGoogleCallback(code, state);
        res.redirect(`${process.env.FRONTEND_URL}/callback?token=${token}`);
    } catch (error) {
        logger.error('Error en Google OAuth callback', { error: error.message });
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
    }
};

module.exports = { redirectToGoogle, googleCallback };
