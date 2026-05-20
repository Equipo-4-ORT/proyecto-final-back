const prisma = require('../../../src/shared/database/prisma');
const {
  listActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  ActivityNotFoundError,
  ActivityForbiddenError,
} = require('../../../src/modules/activities/activities.service');

const ACTIVITY_BASE = {
  activityType: 'tarea',
  startTime: '2026-01-15T09:00:00.000Z',
  endTime: '2026-01-15T10:00:00.000Z',
};

const createTestUser = (email) =>
  prisma.user.create({
    data: { email, fullName: 'Test User', role: 'EMPLOYEE', status: 'ACTIVE' },
  });

beforeEach(async () => {
  await prisma.dailyActivity.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.dailyActivity.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
});

describe('listActivities', () => {
  test('devuelve array vacío cuando el usuario no tiene actividades', async () => {
    const user = await createTestUser('usuario@test.com');
    const result = await listActivities(user.id);
    expect(result).toEqual([]);
  });
});

describe('createActivity', () => {
  test('crea una actividad válida con source manual', async () => {
    const user = await createTestUser('usuario@test.com');

    const activity = await createActivity(user.id, ACTIVITY_BASE);

    expect(activity.id).toBeDefined();
    expect(activity.userId).toBe(user.id);
    expect(activity.source).toBe('manual');
    expect(activity.activityType).toBe(ACTIVITY_BASE.activityType);
    expect(activity.startTime).toEqual(new Date(ACTIVITY_BASE.startTime));
    expect(activity.endTime).toEqual(new Date(ACTIVITY_BASE.endTime));
  });
});

describe('updateActivity', () => {
  test('falla con 403 al intentar editar actividad de otro usuario', async () => {
    const owner = await createTestUser('owner@test.com');
    const other = await createTestUser('other@test.com');

    const activity = await createActivity(owner.id, ACTIVITY_BASE);

    await expect(
      updateActivity(other.id, activity.id, { activityType: 'otra' })
    ).rejects.toThrow(ActivityForbiddenError);
  });
});

describe('deleteActivity', () => {
  test('falla con 404 al intentar borrar una actividad inexistente', async () => {
    const user = await createTestUser('usuario@test.com');

    await expect(
      deleteActivity(user.id, 'id-que-no-existe')
    ).rejects.toThrow(ActivityNotFoundError);
  });
});
