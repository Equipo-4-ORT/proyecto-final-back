const prisma = require('../../shared/database/prisma');
const { getAdapter } = require('../ai/adapters');

class ReportValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReportValidationError';
        this.statusCode = 400;
    }
}

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
                throw new ReportValidationError('El formato de la fecha "from" es inválido.');
            }
            where.reportDate.gte = fromDate;
        }
        if (to) {
            const toDate = new Date(to);
            if (isNaN(toDate.getTime())) {
                throw new ReportValidationError('El formato de la fecha "to" es inválido.');
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
            orderBy: { reportDate: 'desc' },
        }),
    ]);

    const mappedReports = reports.map((r) => ({
        id: r.id,
        date: r.reportDate.toISOString().split('T')[0],
        status: r.status,
        totalHours: r.totalHours || 0,
        xlsxUrl: r.xlsxUrl || null,
    }));

    return {
        data: mappedReports,
        meta: {
            total,
            page: parsedPage,
            limit: take,
            totalPages: Math.ceil(total / take),
        },
    };
};

const generateReportForDate = async (user, dateStr) => {
    const reportDate = new Date(`${dateStr}T00:00:00.000Z`);

    if (isNaN(reportDate.getTime())) {
        throw new ReportValidationError('El formato de la fecha es inválido.');
    }

    console.log('🔍 DEBUG 1: Buscando reporte previo...');


    const existingReport = await prisma.report.findFirst({
      where: {
        
            userId: user.id,
            reportDate: reportDate
     
    }
    });

    if (existingReport) {
       if (existingReport.status === 'SENT') {
            return {
                message: 'Ya existe un reporte para esta fecha y fue enviado exitosamente.',
                reportId: existingReport.id,
            };
        }

        if (existingReport.status === 'PENDING') {
            console.log('✅ DEBUG 1.5: Borrador encontrado. Devolviendo sin llamar a la IA.');
            return {
                message: 'Borrador recuperado exitosamente.',
                report: existingReport,
                preview: existingReport.content 
            };
        }
    }
     
    console.log('🔍 DEBUG 2: Buscando actividades diarias...');
    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    const dailyActivities = await prisma.dailyActivity.findMany({ 
        where: {
            userId: user.id,
            startTime: {
                gte: startOfDay,
                lte: endOfDay,
            }
        },
        orderBy: { startTime: 'asc' },
    });

    if (dailyActivities.length === 0) {
        throw new ReportValidationError('No se encontraron actividades para la fecha proporcionada.');
    }

    console.log(`🔍 DEBUG 3: Invocando IA para ${dailyActivities.length} actividades...`);
    const userContext = {
        name: user.fullName || user.email.split('@')[0],
        role: user.role,
        date: dateStr,
    };

    const aiAdapter = getAdapter();
    const aiPromise = aiAdapter.generateSummary(dailyActivities, userContext);
const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout: La IA tardó más de 30 segundos en responder')), 30000)
);

    const aiOutput = await Promise.race([aiPromise, timeoutPromise]);

    console.log('🔍 DEBUG 4: Persistiendo borrador...');
    
    
    let savedReport;
    if (existingReport) {
        savedReport = await prisma.report.update({
            where: { id: existingReport.id },
            data: {
                totalHours: aiOutput.totalHours,
                content: aiOutput,
                status: 'PENDING'
            }
        });
    } else {
        savedReport = await prisma.report.create({
            data: {
                userId: user.id,
                reportDate: reportDate,
                totalHours: aiOutput.totalHours,
                content: aiOutput,
                status: 'PENDING'
            }
        });
    }

    console.log('✅ DEBUG 5: ¡Éxito!');

    return {
        message: 'Reporte generado exitosamente.',
        report: savedReport,
        preview: aiOutput
    };
};

module.exports = {
    getReportsHistory,
    ReportValidationError,
    generateReportForDate,
};
