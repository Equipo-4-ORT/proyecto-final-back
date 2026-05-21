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
  ActivityNotFoundError,
  ActivityForbiddenError,
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

describe('listActivities', () => {
  test('devuelve las actividades del usuario', async () => {
    prisma.dailyActivity.findMany.mockResolvedValue([MOCK_ACTIVITY]);

    const result = await listActivities('user-id-1');

    expect(result).toEqual([MOCK_ACTIVITY]);
    expect(prisma.dailyActivity.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-id-1' },
      orderBy: { startTime: 'desc' },
    });
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
