const {
  getReportsHistory,
  generateReportForDate,
  ReportValidationError,
  OverlapsDetectedError,
} = require('../../../src/modules/reports/reports.service');
const prisma = require('../../../src/shared/database/prisma');
// Asegurate de que esta ruta coincida con la ubicación real de tu index de adapters
const { getAdapter } = require('../../../src/modules/ai/adapters');
const { createReportSheet } = require('../../../src/modules/reports/reports.sheet');

// 1. Mockeamos Prisma con todas las funciones que usan ambas suites
jest.mock('../../../src/shared/database/prisma', () => ({
  report: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  dailyActivity: {
    findMany: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
}));

// 2. Mockeamos el Adapter de IA
jest.mock('../../../src/modules/ai/adapters', () => ({
  getAdapter: jest.fn(),
}));

// 3. Mockeamos el helper del Sheet. Además de aislar la lógica del Drive, evita
//    importar `googleapis` (que no carga en el entorno de jest sin mock).
jest.mock('../../../src/modules/reports/reports.sheet', () => ({
  createReportSheet: jest.fn(),
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
      { id: 'rep-1', reportDate: mockDate, status: 'SENT', totalHours: 40, xlsxUrl: 'url.xlsx' },
    ]);

    const result = await getReportsHistory(mockUserId, { page: 2, limit: 5 });

    expect(prisma.report.count).toHaveBeenCalledWith({ where: { userId: mockUserId } });
    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: mockUserId },
        skip: 5,
        take: 5,
        orderBy: { reportDate: 'desc' },
      }),
    );

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
        lte: new Date(to),
      },
    };

    expect(prisma.report.count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      }),
    );
  });
});

describe('Report Service - generateReportForDate', () => {
  const mockUser = { id: 'user-123', email: 'test@test.com', role: 'EMPLOYEE' };
  const validDate = '2026-05-19';

  beforeEach(() => {
    // Default: usuario sin la validación de solapamientos habilitada.
    prisma.user.findUnique.mockResolvedValue({ avoidOverlaps: false });
    // Default: la creación del Sheet no produce URL (no aplica salvo que el test la setee).
    createReportSheet.mockResolvedValue(null);
    prisma.report.update.mockResolvedValue({ id: 'report-1', status: 'PENDING' });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('Debe generar un reporte exitosamente (Happy Path)', async () => {
    prisma.report.findFirst.mockResolvedValue(null);
    prisma.dailyActivity.findMany.mockResolvedValue([{ id: 1, title: 'Reunión', duration: 120 }]);

    const mockAiOutput = { totalHours: 2, daySummary: 'Día productivo', rows: [] };
    getAdapter.mockReturnValue({
      generateSummary: jest.fn().mockResolvedValue(mockAiOutput),
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
      generateSummary: jest.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    });

    await expect(generateReportForDate(mockUser, validDate)).rejects.toThrow(
      '503 Service Unavailable',
    );
  });

  describe('Generación del Sheet en Drive', () => {
    const mockAiOutput = { totalHours: 2, daySummary: 'Día productivo', rows: [] };
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/abc123/edit';

    test('Crea el Sheet, persiste xlsxUrl y lo devuelve en la respuesta', async () => {
      prisma.report.findFirst.mockResolvedValue(null);
      prisma.dailyActivity.findMany.mockResolvedValue([{ id: 1 }]);
      getAdapter.mockReturnValue({ generateSummary: jest.fn().mockResolvedValue(mockAiOutput) });
      const savedReport = { id: 'report-1', status: 'PENDING', reportDate: new Date('2026-05-19') };
      prisma.report.create.mockResolvedValue(savedReport);
      createReportSheet.mockResolvedValue(sheetUrl);

      const result = await generateReportForDate(mockUser, validDate);

      expect(createReportSheet).toHaveBeenCalledWith(mockUser, savedReport, mockAiOutput);
      expect(prisma.report.update).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { xlsxUrl: sheetUrl },
      });
      expect(result.xlsxUrl).toBe(sheetUrl);
    });

    test('Si la creación del Sheet falla, el reporte se genera con xlsxUrl null', async () => {
      prisma.report.findFirst.mockResolvedValue(null);
      prisma.dailyActivity.findMany.mockResolvedValue([{ id: 1 }]);
      getAdapter.mockReturnValue({ generateSummary: jest.fn().mockResolvedValue(mockAiOutput) });
      prisma.report.create.mockResolvedValue({ id: 'report-1', status: 'PENDING', reportDate: new Date('2026-05-19') });
      createReportSheet.mockResolvedValue(null);

      const result = await generateReportForDate(mockUser, validDate);

      expect(result.message).toBe('Reporte generado exitosamente.');
      expect(result.xlsxUrl).toBeNull();
      // No se intenta persistir un xlsxUrl inexistente.
      expect(prisma.report.update).not.toHaveBeenCalled();
    });

    test('Borrador PENDING con xlsxUrl null: reintenta crear el Sheet sin llamar a la IA', async () => {
      const draft = {
        id: 'report-1',
        status: 'PENDING',
        content: mockAiOutput,
        xlsxUrl: null,
        reportDate: new Date('2026-05-19'),
      };
      prisma.report.findFirst.mockResolvedValue(draft);
      createReportSheet.mockResolvedValue(sheetUrl);

      const result = await generateReportForDate(mockUser, validDate);

      expect(getAdapter).not.toHaveBeenCalled();
      expect(createReportSheet).toHaveBeenCalledWith(mockUser, draft, mockAiOutput);
      expect(prisma.report.update).toHaveBeenCalledWith({
        where: { id: 'report-1' },
        data: { xlsxUrl: sheetUrl },
      });
      expect(result.xlsxUrl).toBe(sheetUrl);
    });

    test('Borrador PENDING que ya tiene xlsxUrl: no reintenta ni recrea el Sheet', async () => {
      const draft = {
        id: 'report-1',
        status: 'PENDING',
        content: mockAiOutput,
        xlsxUrl: sheetUrl,
        reportDate: new Date('2026-05-19'),
      };
      prisma.report.findFirst.mockResolvedValue(draft);

      const result = await generateReportForDate(mockUser, validDate);

      expect(createReportSheet).not.toHaveBeenCalled();
      expect(result.xlsxUrl).toBe(sheetUrl);
    });

    test('Reporte SENT: devuelve el xlsxUrl existente sin crear Sheet', async () => {
      prisma.report.findFirst.mockResolvedValue({ id: 'report-1', status: 'SENT', xlsxUrl: sheetUrl });

      const result = await generateReportForDate(mockUser, validDate);

      expect(createReportSheet).not.toHaveBeenCalled();
      expect(result.xlsxUrl).toBe(sheetUrl);
    });
  });

  describe('Validación de solapamientos (avoidOverlaps)', () => {
    // Dos actividades que se pisan: la 2da arranca antes de que termine la 1ra.
    const overlappingActivities = [
      { id: 1, startTime: '2026-05-19T09:00:00Z', endTime: '2026-05-19T10:00:00Z' },
      { id: 2, startTime: '2026-05-19T09:30:00Z', endTime: '2026-05-19T11:00:00Z' },
    ];

    test('Si avoidOverlaps está apagado, NO chequea solapamientos y genera el reporte (hasOverlaps: false)', async () => {
      prisma.user.findUnique.mockResolvedValue({ avoidOverlaps: false });
      prisma.report.findFirst.mockResolvedValue(null);
      // Aún con actividades solapadas, al estar el flag apagado debe generar.
      prisma.dailyActivity.findMany.mockResolvedValue(overlappingActivities);

      const mockAiOutput = { totalHours: 2, daySummary: 'ok', rows: [] };
      getAdapter.mockReturnValue({
        generateSummary: jest.fn().mockResolvedValue(mockAiOutput),
      });
      prisma.report.create.mockResolvedValue({ id: 'report-1', status: 'PENDING' });

      const result = await generateReportForDate(mockUser, validDate);

      expect(result.hasOverlaps).toBe(false);
      expect(result.message).toBe('Reporte generado exitosamente.');
      expect(getAdapter).toHaveBeenCalled();
      expect(prisma.report.create).toHaveBeenCalled();
    });

    test('Si avoidOverlaps está prendido y hay solapamientos, bloquea y NO invoca a la IA', async () => {
      prisma.user.findUnique.mockResolvedValue({ avoidOverlaps: true });
      prisma.report.findFirst.mockResolvedValue(null);
      prisma.dailyActivity.findMany.mockResolvedValue(overlappingActivities);

      await expect(generateReportForDate(mockUser, validDate)).rejects.toThrow(
        OverlapsDetectedError,
      );

      // El bloqueo debe ocurrir antes de gastar una llamada a la IA o persistir.
      expect(getAdapter).not.toHaveBeenCalled();
      expect(prisma.report.create).not.toHaveBeenCalled();
    });

    test('Si avoidOverlaps está prendido pero NO hay solapamientos, genera el reporte (hasOverlaps: false)', async () => {
      prisma.user.findUnique.mockResolvedValue({ avoidOverlaps: true });
      prisma.report.findFirst.mockResolvedValue(null);
      // Actividades consecutivas que no se pisan (una termina cuando arranca la otra).
      prisma.dailyActivity.findMany.mockResolvedValue([
        { id: 1, startTime: '2026-05-19T09:00:00Z', endTime: '2026-05-19T10:00:00Z' },
        { id: 2, startTime: '2026-05-19T10:00:00Z', endTime: '2026-05-19T11:00:00Z' },
      ]);

      const mockAiOutput = { totalHours: 2, daySummary: 'ok', rows: [] };
      getAdapter.mockReturnValue({
        generateSummary: jest.fn().mockResolvedValue(mockAiOutput),
      });
      prisma.report.create.mockResolvedValue({ id: 'report-1', status: 'PENDING' });

      const result = await generateReportForDate(mockUser, validDate);

      expect(result.hasOverlaps).toBe(false);
      expect(result.message).toBe('Reporte generado exitosamente.');
      expect(getAdapter).toHaveBeenCalled();
    });
  });
});
