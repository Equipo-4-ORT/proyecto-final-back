const { persistCalendarActivities } = require('./calendar.service');;
const prisma = require('../../shared/database/prisma');
const { decrypt } = require('../../shared/utils/crypto');

const syncCalendar = async (req, res) => {
    try { 
        const userId = req.user.id;

        const {date} = req.body;

        if (!date) {
            return res.status(400).json({ error: 'La fecha es requerida' });
        }

        const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: { refreshToken: true }
        });

        if (!user || !user.refreshToken) {
            return res.status(400).json({ error: 'Usuario no encontrado o sin token de actualización' });
        }

        const tokenRealDecifrado = decrypt(user.refreshToken);
        const result = await persistCalendarActivities(userId, tokenRealDecifrado, date);
        res.status(200).json(result);
    } catch (error) {
        console.error('Error sincronizando calendario:', error);
        res.status(500).json({ error: 'Error sincronizando calendario' });
    }
};

module.exports = {
    syncCalendar,
};
