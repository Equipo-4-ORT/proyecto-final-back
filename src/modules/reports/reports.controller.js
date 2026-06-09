const { getReportsHistory, ReportValidationError, generateReportForDate } = require('./reports.service');
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

const generateReport = async (req, res) => {
    try {
        console.log('🔍 Generando reporte para usuario:', req.user.id);
        const { date } = req.body;

        if (!date) {
            throw new ReportValidationError('La fecha es requerida para generar el reporte.');
        }

        const result = await generateReportForDate(req.user, date);

        return res.status(200).json(result);
    }  catch (error) {
        
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('🔥 PRISMA ERROR DETAILS:', error.message);
        logger.error('Error generando el reporte', { error });
        return res.status(500).json({ error: 'Ocurrió un error interno al generar el reporte.' });
    }
}

module.exports = {
    getReports,
    generateReport,
};
