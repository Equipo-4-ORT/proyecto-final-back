const { getReportsHistory } = require('./reports.service');
const logger = require('../../shared/utils/logger');

const getReports = async (req, res) => {
    try {
        const userId = req.user.id;

        const{ page, limit, from, to } = req.query;
        const result = await getReportsHistory(userId, { page, limit, from, to });
        return res.status(200).json(result);
        
    } catch (error) {
        // Atrapamos el error de validación que tira nuestro servicio
        if (error.message.includes('inválido')) {
            return res.status(400).json({ error: error.message });
        }
        
        console.error('Error obteniendo el historial de reportes:', error);
        return res.status(500).json({ error: 'Ocurrió un error interno al obtener el historial.' });
    }
};

module.exports = {
    getReports,
};