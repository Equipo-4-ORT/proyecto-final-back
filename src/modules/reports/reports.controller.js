const { getReportsHistory } = require('./reports.service');
const logger = require('../../shared/utils/logger');

const getReports = async (req, res) => {
    try {
        const userId = req.user.id;

        const{ page, limit, from, to } = req.query;

        const reports = await getReportsHistory(userId, { page, limit, from, to });

        return res.status(200).json(reports);
    } catch (error) {
        logger.error('Error fetching reports history', { message: error.message });
        return res.status(500).json({ error: 'Error fetching reports history' });
    }
};

module.exports = {
    getReports,
};