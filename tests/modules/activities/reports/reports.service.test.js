const { getReportsHistory } = require('../../../../src/modules/reports/reports.service');
const prisma = require('../../../../src/shared/database/prisma');

// Mockeamos Prisma
jest.mock('../../../../src/shared/database/prisma', () => ({
  report: {
    count: jest.fn(),
    findMany: jest.fn()
  }
}));

describe('Reports Service - getReportsHistory', () => {
  const mockUserId = 'user-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Debe devolver los reportes paginados correctamente (Caso por defecto)', async () => {
    // 1. Preparamos los datos falsos que devolverá la BD
    const mockDate = new Date('2026-06-02T12:00:00Z');
    prisma.report.count.mockResolvedValue(15);
    prisma.report.findMany.mockResolvedValue([
      { id: 'rep-1', reportDate: mockDate, status: 'SENT', totalHours: 40, xlsxUrl: 'url.xlsx' }
    ]);

    // 2. Ejecutamos la función (pidiendo página 2, límite 5)
    const result = await getReportsHistory(mockUserId, { page: 2, limit: 5 });

    // 3. Verificamos que Prisma haya recibido los cálculos matemáticos correctos
    expect(prisma.report.count).toHaveBeenCalledWith({ where: { userId: mockUserId } });
    expect(prisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: mockUserId },
      skip: 5, // (page 2 - 1) * 5
      take: 5,
      orderBy: { reportDate: 'desc' }
    }));

    // 4. Verificamos la metadata de respuesta para el frontend
    expect(result.meta.total).toBe(15);
    expect(result.meta.page).toBe(2);
    expect(result.meta.totalPages).toBe(3); // 15 / 5 = 3
    
    // 5. Verificamos que la fecha se formatee bien a YYYY-MM-DD
    expect(result.data[0].date).toBe('2026-06-02');
  });

  test('Debe aplicar los filtros de fechas (from / to) correctamente', async () => {
    prisma.report.count.mockResolvedValue(1);
    prisma.report.findMany.mockResolvedValue([]);

    const from = '2026-05-01';
    const to = '2026-05-31';

    await getReportsHistory(mockUserId, { page: 1, limit: 10, from, to });

    // Verificamos que Prisma construya el objeto "where" de fechas con gte y lte
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