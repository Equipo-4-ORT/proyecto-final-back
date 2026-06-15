jest.mock('../../../src/shared/database/prisma', () => ({
  dailyActivity: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

const {
  listActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  dayToUTCRange,
  ActivityNotFoundError,
  ActivityForbiddenError,
  InvalidTimezoneError,
} = require('../../../src/modules/activities/activities.service');
const prisma = require('../../../src/shared/database/prisma');

const ACTIVITY_BASE = {
  activityType: 'tarea',
  startTime: '2026-01-15T09:00:00.000Z',
  endTime: '2026-01-15T10:00:00.000Z',
};

const MOCK_ACTIVITY = {
  id: 'activity-id-1',
  userId: 'user-id-1',
  source: 'manual',
  activityType: 'tarea',
  startTime: new Date('2026-01-15T09:00:00.000Z'),
  endTime: new Date('2026-01-15T10:00:00.000Z'),
  metadata: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('dayToUTCRange', () => {
  test('convierte una fecha y timezone válidos al rango UTC correcto', () => {
    // América/Argentina/Buenos_Aires = UTC-3 (sin horario de verano)
    const range = dayToUTCRange('2025-05-24', 'America/Argentina/Buenos_Aires');

    expect(range.gte).toEqual(new Date('2025-05-24T03:00:00.000Z'));
    expect(range.lt).toEqual(new Date('2025-05-25T03:00:00.000Z'));
  });

  test('convierte correctamente para UTC+0', () => {
    const range = dayToUTCRange('2025-05-24', 'UTC');

    expect(range.gte).toEqual(new Date('2025-05-24T00:00:00.000Z'));
    expect(range.lt).toEqual(new Date('2025-05-25T00:00:00.000Z'));
  });

  test('lanza InvalidTimezoneError si el timezone no es un identificador IANA válido', () => {
    expect(() => dayToUTCRange('2025-05-24', 'Zona/Invalida')).toThrow(InvalidTimezoneError);
  });
});

describe('listActivities', () => {
  // listActivities agrega siempre este OR para ocultar al front las actividades de
  // Drive sin fileType relevante (document/spreadsheet/presentation).
  const DRIVE_FILETYPE_OR = [
    { source: { not: 'drive' } },
    { source: 'drive', fileType: { in: ['document', 'spreadsheet', 'presentation'] } },
  ];

  test('devuelve las actividades del usuario sin filtros', async () => {
    prisma.dailyActivity.findMany.mockResolvedValue([MOCK_ACTIVITY]);

    const result = await listActivities('user-id-1');

    expect(result).toEqual([MOCK_ACTIVITY]);
    expect(prisma.dailyActivity.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-id-1', OR: DRIVE_FILETYPE_OR },
      orderBy: { startTime: 'desc' },
    });
  });

  test('filtra por source cuando se provee', async () => {
    prisma.dailyActivity.findMany.mockResolvedValue([]);

    await listActivities('user-id-1', { source: 'drive' });

    expect(prisma.dailyActivity.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-id-1', source: 'drive', OR: DRIVE_FILETYPE_OR },
      orderBy: { startTime: 'desc' },
    });
  });

  test('filtra por rango UTC cuando se provee date y timezone', async () => {
    prisma.dailyActivity.findMany.mockResolvedValue([]);

    await listActivities('user-id-1', { date: '2025-05-24', timezone: 'America/Argentina/Buenos_Aires' });

    expect(prisma.dailyActivity.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id-1',
        startTime: {
          gte: new Date('2025-05-24T03:00:00.000Z'),
          lt:  new Date('2025-05-25T03:00:00.000Z'),
        },
        OR: DRIVE_FILETYPE_OR,
      },
      orderBy: { startTime: 'desc' },
    });
  });

  test('combina source y filtro de fecha cuando se proveen ambos', async () => {
    prisma.dailyActivity.findMany.mockResolvedValue([]);

    await listActivities('user-id-1', { date: '2025-05-24', timezone: 'UTC', source: 'drive' });

    expect(prisma.dailyActivity.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id-1',
        source: 'drive',
        startTime: {
          gte: new Date('2025-05-24T00:00:00.000Z'),
          lt:  new Date('2025-05-25T00:00:00.000Z'),
        },
        OR: DRIVE_FILETYPE_OR,
      },
      orderBy: { startTime: 'desc' },
    });
  });

  test('propaga InvalidTimezoneError si el timezone es inválido', async () => {
    await expect(
      listActivities('user-id-1', { date: '2025-05-24', timezone: 'Zona/Invalida' })
    ).rejects.toThrow(InvalidTimezoneError);
  });
});

describe('createActivity', () => {
  test('crea una actividad con source manual y fechas convertidas', async () => {
    prisma.dailyActivity.create.mockResolvedValue(MOCK_ACTIVITY);

    const result = await createActivity('user-id-1', ACTIVITY_BASE);

    expect(result).toEqual(MOCK_ACTIVITY);
    expect(prisma.dailyActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-id-1',
        source: 'manual',
        activityType: 'tarea',
        startTime: new Date(ACTIVITY_BASE.startTime),
        endTime: new Date(ACTIVITY_BASE.endTime),
      }),
    });
  });
});

describe('updateActivity', () => {
  test('lanza ActivityNotFoundError si la actividad no existe', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(null);

    await expect(
      updateActivity('user-id-1', 'no-existe', { activityType: 'otra' })
    ).rejects.toThrow(ActivityNotFoundError);
  });

  test('lanza ActivityForbiddenError si la actividad pertenece a otro usuario', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue({ ...MOCK_ACTIVITY, userId: 'otro-user' });

    await expect(
      updateActivity('user-id-1', 'activity-id-1', { activityType: 'otra' })
    ).rejects.toThrow(ActivityForbiddenError);
  });

  test('actualiza la actividad cuando el usuario es el propietario', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(MOCK_ACTIVITY);
    const updated = { ...MOCK_ACTIVITY, activityType: 'reunión' };
    prisma.dailyActivity.update.mockResolvedValue(updated);

    const result = await updateActivity('user-id-1', 'activity-id-1', { activityType: 'reunión' });

    expect(result).toEqual(updated);
    expect(prisma.dailyActivity.update).toHaveBeenCalled();
  });

  test('lanza ActivityNotFoundError si la BD reporta P2025 (race condition)', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(MOCK_ACTIVITY);
    prisma.dailyActivity.update.mockRejectedValue(Object.assign(new Error('Record not found'), { code: 'P2025' }));

    await expect(
      updateActivity('user-id-1', 'activity-id-1', { activityType: 'otra' })
    ).rejects.toThrow(ActivityNotFoundError);
  });
});

describe('deleteActivity', () => {
  test('lanza ActivityNotFoundError si la actividad no existe', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(null);

    await expect(
      deleteActivity('user-id-1', 'no-existe')
    ).rejects.toThrow(ActivityNotFoundError);
  });

  test('lanza ActivityForbiddenError si la actividad pertenece a otro usuario', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue({ ...MOCK_ACTIVITY, userId: 'otro-user' });

    await expect(
      deleteActivity('user-id-1', 'activity-id-1')
    ).rejects.toThrow(ActivityForbiddenError);
  });

  test('elimina la actividad cuando el usuario es el propietario', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(MOCK_ACTIVITY);
    prisma.dailyActivity.delete.mockResolvedValue(MOCK_ACTIVITY);

    await deleteActivity('user-id-1', 'activity-id-1');

    expect(prisma.dailyActivity.delete).toHaveBeenCalledWith({ where: { id: 'activity-id-1' } });
  });

  test('lanza ActivityNotFoundError si la BD reporta P2025 (race condition)', async () => {
    prisma.dailyActivity.findUnique.mockResolvedValue(MOCK_ACTIVITY);
    prisma.dailyActivity.delete.mockRejectedValue(Object.assign(new Error('Record not found'), { code: 'P2025' }));

    await expect(
      deleteActivity('user-id-1', 'activity-id-1')
    ).rejects.toThrow(ActivityNotFoundError);
  });
});
