const { getReportsHistory, generateReportForDate, ReportValidationError } = require('../../../src/modules/reports/reports.service');
const prisma = require('../../../src/shared/database/prisma');
// Asegurate de que esta ruta coincida con la ubicación real de tu index de adapters
const { getAdapter } = require('../../../src/modules/ai/adapters');

// 1. Mockeamos Prisma con todas las funciones que usan ambas suites
jest.mock('../../../src/shared/database/prisma', () => ({
  report: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  dailyActivity: {
    findMany: jest.fn()
  }
}));

// 2. Mockeamos el Adapter de IA
jest.mock('../../../src/modules/ai/adapters', () => ({
  getAdapter: jest.fn()
}));

describe('Reports Service - getReportsHistory', () => {
  const mockUserId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Debe devolver los reportes paginados correctamente (Caso por defecto)', async () => {
    const mockDate = new Date('2026-06-02T12:00:00Z');
    prisma.report.count.mockResolvedValue(15);
    prisma.report.findMany.mockResolvedValue([
      { id: 'rep-1', reportDate: mockDate, status: 'SENT', totalHours: 40, xlsxUrl: 'url.xlsx' }
    ]);

    const result = await getReportsHistory(mockUserId, { page: 2, limit: 5 });

    expect(prisma.report.count).toHaveBeenCalledWith({ where: { userId: mockUserId } });
    expect(prisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: mockUserId },
      skip: 5,
      take: 5,
      orderBy: { reportDate: 'desc' }
    }));

    expect(result.meta.total).toBe(15);
    expect(result.meta.page).toBe(2);
    expect(result.meta.totalPages).toBe(3);
    expect(result.data[0].date).toBe('2026-06-02');
  });

  test('Debe aplicar los filtros de fechas (from / to) correctamente', async () => {
    prisma.report.count.mockResolvedValue(1);
    prisma.report.findMany.mockResolvedValue([]);

    const from = '2026-05-01';
    const to = '2026-05-31';

    await getReportsHistory(mockUserId, { page: 1, limit: 10, from, to });

    const expectedWhere = {
      userId: mockUserId,
      reportDate: {
        gte: new Date(from),
        lte: new Date(to)
      }
    };

    expect(prisma.report.count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(prisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expectedWhere
    }));
  });
});

describe('Report Service - generateReportForDate', () => {
  const mockUser = { id: 'user-123', email: 'test@test.com', role: 'EMPLOYEE' };
  const validDate = '2026-05-19';

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('Debe generar un reporte exitosamente (Happy Path)', async () => {
    prisma.report.findFirst.mockResolvedValue(null);
    prisma.dailyActivity.findMany.mockResolvedValue([
        { id: 1, title: 'Reunión', duration: 120 }
    ]);
    
    const mockAiOutput = { totalHours: 2, daySummary: 'Día productivo', rows: [] };
    getAdapter.mockReturnValue({
        generateSummary: jest.fn().mockResolvedValue(mockAiOutput)
    });

    prisma.report.create.mockResolvedValue({ id: 'report-1', status: 'PENDING' });

    const result = await generateReportForDate(mockUser, validDate);

    expect(result.message).toBe('Reporte generado exitosamente.');
    expect(result.preview).toEqual(mockAiOutput);
    expect(prisma.report.create).toHaveBeenCalled();
  });

  test('Debe cortar la ejecución si ya existe un reporte en estado SENT', async () => {
    prisma.report.findFirst.mockResolvedValue({ id: 'report-1', status: 'SENT' });

    const result = await generateReportForDate(mockUser, validDate);

    expect(result.message).toBe('Ya existe un reporte para esta fecha y fue enviado exitosamente.');
    expect(result.reportId).toBe('report-1');
    
    expect(prisma.dailyActivity.findMany).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
  });

  test('Debe propagar el error si la IA falla (ej: 503 Service Unavailable)', async () => {
    prisma.report.findFirst.mockResolvedValue(null);
    prisma.dailyActivity.findMany.mockResolvedValue([{ id: 1 }]);
    
    getAdapter.mockReturnValue({
        generateSummary: jest.fn().mockRejectedValue(new Error('503 Service Unavailable'))
    });

    await expect(generateReportForDate(mockUser, validDate)).rejects.toThrow('503 Service Unavailable');
  });
});
