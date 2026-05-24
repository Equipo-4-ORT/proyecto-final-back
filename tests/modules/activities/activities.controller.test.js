jest.mock('../../../src/modules/activities/activities.service', () => {
    class ActivityNotFoundError extends Error {
        constructor() { super('Actividad no encontrada'); this.name = 'ActivityNotFoundError'; this.statusCode = 404; }
    }
    class ActivityForbiddenError extends Error {
        constructor() { super('No tenés permiso'); this.name = 'ActivityForbiddenError'; this.statusCode = 403; }
    }
    return {
        listActivities: jest.fn(),
        createActivity: jest.fn(),
        updateActivity: jest.fn(),
        deleteActivity: jest.fn(),
        ActivityNotFoundError,
        ActivityForbiddenError,
    };
});
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
}));

const { getActivities, postActivity, putActivity, deleteActivityHandler } =
    require('../../../src/modules/activities/activities.controller');
const { listActivities, createActivity, updateActivity, deleteActivity, ActivityNotFoundError, ActivityForbiddenError } =
    require('../../../src/modules/activities/activities.service');

const MOCK_ACTIVITY = {
    id: 'act-1',
    userId: 'user-1',
    activityType: 'tarea',
    startTime: new Date('2026-01-15T09:00:00.000Z'),
    endTime: new Date('2026-01-15T10:00:00.000Z'),
};

let req, res;
beforeEach(() => {
    jest.clearAllMocks();
    res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
    req = { user: { id: 'user-1' }, body: {}, params: {} };
});

describe('getActivities', () => {
    test('responde 200 con la lista de actividades', async () => {
        listActivities.mockResolvedValue([MOCK_ACTIVITY]);

        await getActivities(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith([MOCK_ACTIVITY]);
    });

    test('responde 500 ante error inesperado', async () => {
        listActivities.mockRejectedValue(new Error('DB caída'));

        await getActivities(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('postActivity', () => {
    test('responde 400 si falta algún campo requerido', async () => {
        req.body = { activityType: 'tarea', startTime: '2026-01-15T09:00:00.000Z' };

        await postActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    test('responde 400 si startTime es posterior o igual a endTime', async () => {
        req.body = { activityType: 'tarea', startTime: '2026-01-15T10:00:00.000Z', endTime: '2026-01-15T09:00:00.000Z' };

        await postActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('startTime') }));
    });

    test('responde 201 con la actividad creada en el caso exitoso', async () => {
        req.body = { activityType: 'tarea', startTime: '2026-01-15T09:00:00.000Z', endTime: '2026-01-15T10:00:00.000Z' };
        createActivity.mockResolvedValue(MOCK_ACTIVITY);

        await postActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(MOCK_ACTIVITY);
    });

    test('responde 500 ante error inesperado', async () => {
        req.body = { activityType: 'tarea', startTime: '2026-01-15T09:00:00.000Z', endTime: '2026-01-15T10:00:00.000Z' };
        createActivity.mockRejectedValue(new Error('DB caída'));

        await postActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('putActivity', () => {
    test('responde 400 si ambas fechas se envían y startTime >= endTime', async () => {
        req.body = { startTime: '2026-01-15T10:00:00.000Z', endTime: '2026-01-15T09:00:00.000Z' };
        req.params.id = 'act-1';

        await putActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    test('responde 200 con la actividad actualizada', async () => {
        req.body = { activityType: 'reunión' };
        req.params.id = 'act-1';
        updateActivity.mockResolvedValue({ ...MOCK_ACTIVITY, activityType: 'reunión' });

        await putActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'reunión' }));
    });

    test('responde 404 si la actividad no existe', async () => {
        req.body = { activityType: 'reunión' };
        req.params.id = 'no-existe';
        updateActivity.mockRejectedValue(new ActivityNotFoundError());

        await putActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    test('responde 403 si la actividad pertenece a otro usuario', async () => {
        req.body = { activityType: 'reunión' };
        req.params.id = 'act-1';
        updateActivity.mockRejectedValue(new ActivityForbiddenError());

        await putActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('responde 500 ante error inesperado', async () => {
        req.body = { activityType: 'reunión' };
        req.params.id = 'act-1';
        updateActivity.mockRejectedValue(new Error('DB caída'));

        await putActivity(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('deleteActivityHandler', () => {
    test('responde 204 al eliminar exitosamente', async () => {
        req.params.id = 'act-1';
        deleteActivity.mockResolvedValue();

        await deleteActivityHandler(req, res);

        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.send).toHaveBeenCalled();
    });

    test('responde 404 si la actividad no existe', async () => {
        req.params.id = 'no-existe';
        deleteActivity.mockRejectedValue(new ActivityNotFoundError());

        await deleteActivityHandler(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    test('responde 403 si la actividad pertenece a otro usuario', async () => {
        req.params.id = 'act-1';
        deleteActivity.mockRejectedValue(new ActivityForbiddenError());

        await deleteActivityHandler(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('responde 500 ante error inesperado', async () => {
        req.params.id = 'act-1';
        deleteActivity.mockRejectedValue(new Error('DB caída'));

        await deleteActivityHandler(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});
