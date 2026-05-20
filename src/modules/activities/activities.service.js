const prisma = require('../../shared/database/prisma');

class ActivityNotFoundError extends Error {
  constructor() {
    super('Actividad no encontrada');
    this.name = 'ActivityNotFoundError';
    this.statusCode = 404;
  }
}

class ActivityForbiddenError extends Error {
  constructor() {
    super('No tenés permiso para modificar esta actividad');
    this.name = 'ActivityForbiddenError';
    this.statusCode = 403;
  }
}

const listActivities = (userId) => {
  return prisma.dailyActivity.findMany({
    where: { userId },
    orderBy: { startTime: 'desc' },
  });
};

const createActivity = (userId, { activityType, startTime, endTime, metadata }) => {
  return prisma.dailyActivity.create({
    data: {
      userId,
      source: 'manual',
      activityType,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      metadata: metadata ?? undefined,
    },
  });
};

const updateActivity = async (userId, id, { activityType, startTime, endTime, metadata }) => {
  const activity = await prisma.dailyActivity.findUnique({ where: { id } });

  if (!activity) throw new ActivityNotFoundError();
  if (activity.userId !== userId) throw new ActivityForbiddenError();

  return prisma.dailyActivity.update({
    where: { id },
    data: {
      ...(activityType && { activityType }),
      ...(startTime && { startTime: new Date(startTime) }),
      ...(endTime && { endTime: new Date(endTime) }),
      ...(metadata !== undefined && { metadata }),
    },
  });
};

const deleteActivity = async (userId, id) => {
  const activity = await prisma.dailyActivity.findUnique({ where: { id } });

  if (!activity) throw new ActivityNotFoundError();
  if (activity.userId !== userId) throw new ActivityForbiddenError();

  await prisma.dailyActivity.delete({ where: { id } });
};

module.exports = {
  listActivities,
  createActivity,
  updateActivity,
  deleteActivity,
  ActivityNotFoundError,
  ActivityForbiddenError,
};
