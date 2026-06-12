const prisma = require('../../shared/database/prisma');
const { getAdapter } = require('../ai/adapters');
const { dayToUTCRange } = require('../activities/activities.service');
const config = require('../../shared/config');
const logger = require('../../shared/utils/logger');

class ReportValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReportValidationError';
        this.statusCode = 400;
    }
}

class OverlapsDetectedError extends Error {
    constructor() {
        super('No se puede generar el reporte: existen actividades superpuestas en este día.');
        this.name = 'OverlapsDetectedError';
        this.hasOverlaps = true;
        this.statusCode = 409;
    }
}

const checkOverlaps = (activities) => {
    if (!activities || activities.length <= 1) return false;

    for (let i = 1; i < activities.length; i++) {
        const currentStartTime = new Date(activities[i].startTime);
        const previousEndTime = new Date(activities[i - 1].endTime);

        if (currentStartTime < previousEndTime) {
            return true;
        }
    }
    return false;
};

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

    logger.debug('Buscando reporte previo', { userId: user.id, date: dateStr });

    const existingReport = await prisma.report.findFirst({
        where: {
            userId: user.id,
            reportDate,
        },
    });

    if (existingReport) {
        if (existingReport.status === 'SENT') {
            return {
                message: 'Ya existe un reporte para esta fecha y fue enviado exitosamente.',
                reportId: existingReport.id,
            };
        }

        if (existingReport.status === 'PENDING') {
            logger.debug('Borrador encontrado; se devuelve sin llamar a la IA', { reportId: existingReport.id });
            return {
                message: 'Borrador recuperado exitosamente.',
                report: existingReport,
                preview: existingReport.content,
            };
        }
    }

    // El día se interpreta en la timezone del despliegue (la misma que usa el
    // batch diario) para no perder/colar actividades por el offset UTC. Ver
    // dayToUTCRange en activities.service.js.
    const { gte, lt } = dayToUTCRange(dateStr, config.schedulerTimezone);

    logger.debug('Buscando actividades diarias', { userId: user.id, gte, lt });
    const dailyActivities = await prisma.dailyActivity.findMany({
        where: {
            userId: user.id,
            startTime: { gte, lt },
        },
        orderBy: { startTime: 'asc' },
    });

    if (dailyActivities.length === 0) {
        throw new ReportValidationError('No se encontraron actividades para la fecha proporcionada.');
    }

    if (checkOverlaps(dailyActivities)) {
        logger.warn('Generación de reporte abortada: Solapamiento detectado', { userId: user.id, date: dateStr })
        throw new OverlapsDetectedError();
    }

    logger.debug('Invocando IA', { activities: dailyActivities.length });
    const userContext = {
        name: user.fullName || user.email.split('@')[0],
        role: user.role,
        date: dateStr,
    };

    // El timeout y los reintentos los maneja el propio adapter (ver
    // REQUEST_TIMEOUT_MS / MAX_RETRIES en los adapters); no duplicamos esa
    // lógica acá para no dejar timers colgados ni competir con sus retries.
    const aiAdapter = getAdapter();
    const aiOutput = await aiAdapter.generateSummary(dailyActivities, userContext);

    logger.debug('Persistiendo borrador', { userId: user.id });

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

    logger.debug('Reporte generado correctamente', { reportId: savedReport.id });

    return {
        message: 'Reporte generado exitosamente.',
        report: savedReport,
        preview: aiOutput
    };
};

module.exports = {
    getReportsHistory,
    ReportValidationError,
    OverlapsDetectedError,
    generateReportForDate,
};
