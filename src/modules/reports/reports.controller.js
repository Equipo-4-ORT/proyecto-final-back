const { getReportsHistory } = require('./reports.service');
const logger = require('../../shared/utils/logger');

const getReports = async (req, res) => {
    try {
        const userId = req.user.id;

        const { page, limit, from, to } = req.query;
        const result = await getReportsHistory(userId, { page, limit, from, to });
        return res.status(200).json(result);
    } catch (error) {
        // ReportValidationError trae statusCode 400
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        logger.error('Error obteniendo el historial de reportes', { error });
        return res.status(500).json({ error: 'Ocurrió un error interno al obtener el historial.' });
    }
};

module.exports = {
    getReports,
};
