const prisma = require('../../shared/database/prisma');

const getReportsHistory = async (userId, { page = 1, limit = 10, from, to }) => {

    const skip = (page - 1) * limit;
    const take = parseInt(limit);

    const where = { userId };

    if (from || to) {
        where.reportDate = {};
        if (from) where.reportDate.gte = new Date(from);    

        if (to) where.reportDate.lte = new Date(to);
    }

    const [total, reports] = await Promise.all([
        prisma.report.count({ where }),
        prisma.report.findMany({
            where,
            skip,
            take,
            orderBy: { reportDate: 'desc' },
        }),
    ]);

    const mappedReports = reports.map(r => ({
        id: r.id,
        date: r.reportDate.toISOString().split('T')[0],
        status: r.status,
        totalHours: r.totalHours || 0,
        xlsxUrl: r.xlsxUrl || null
    }));

    return {
        data: mappedReports,
        meta: {
            total,
            page: parseInt(page),
            limit: take,
            totalPages: Math.ceil(total / take),
        }
    };
};

module.exports = {
    getReportsHistory,
};