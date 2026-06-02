const prisma = require('../../shared/database/prisma');

const getReportsHistory = async (userId, { page = 1, limit = 10, from, to }) => {


    const parsedPage = Math.max(1, parseInt(page, 10) || 1);

    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (parsedPage - 1) * parsedLimit;
    const take = parsedLimit;

    const where = { userId };

    if (from || to) {
        where.reportDate = {};
        if (from) {
            const fromDate = new Date(from);
            // Si la fecha es inválida (ej: "hola"), getTime() da NaN
            if (isNaN(fromDate.getTime())) {
                throw new Error('El formato de la fecha "from" es inválido.');
            }
            where.reportDate.gte = fromDate;
        }
        if (to) {
            const toDate = new Date(to);
            if (isNaN(toDate.getTime())) {
                throw new Error('El formato de la fecha "to" es inválido.');
            }
            where.reportDate.lte = toDate;
        }
    }

  const [total, reports] = await Promise.all([
        prisma.report.count({ where }),
        prisma.report.findMany({
            where,
            skip,
            take,
            orderBy: { reportDate: 'desc' }
        })
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
            page: parsedPage,
            limit: take,
            totalPages: Math.ceil(total / take)
        }
    };
};

module.exports = {
    getReportsHistory,
};