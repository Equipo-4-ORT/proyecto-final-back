process.env.JIRA_CLIENT_ID = 'test-client-id';
process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
process.env.JIRA_REDIRECT_URI = 'http://localhost:3000/api/jira/auth/callback';
process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

jest.mock('../../../src/modules/jira/jira.service', () => ({
    initiateConnection: jest.fn(),
    handleCallback: jest.fn(),
    getStatus: jest.fn(),
    disconnect: jest.fn(),
    syncForUser: jest.fn(),
}));

const service = require('../../../src/modules/jira/jira.service');
const controller = require('../../../src/modules/jira/jira.controller');

const makeRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.redirect = jest.fn(() => res);
    return res;
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('jira.controller — getAuthUrl', () => {
    test('200 con la authorizationUrl del service', async () => {
        service.initiateConnection.mockResolvedValue({ authorizationUrl: 'https://auth.atlassian.net/x' });
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        const next = jest.fn();
        await controller.getAuthUrl(req, res, next);
        expect(service.initiateConnection).toHaveBeenCalledWith('u1');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ authorizationUrl: 'https://auth.atlassian.net/x' });
        expect(next).not.toHaveBeenCalled();
    });

    test('sin req.user → next con error 401', async () => {
        const req = {};
        const res = makeRes();
        const next = jest.fn();
        await controller.getAuthUrl(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'unauthenticated' }));
        expect(service.initiateConnection).not.toHaveBeenCalled();
    });

    test('error del service → next(error)', async () => {
        const boom = new Error('boom');
        service.initiateConnection.mockRejectedValue(boom);
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        const next = jest.fn();
        await controller.getAuthUrl(req, res, next);
        expect(next).toHaveBeenCalledWith(boom);
    });
});

describe('jira.controller — handleCallback', () => {
    test('outcome connected → redirect 302 a /profile?jira=connected', async () => {
        service.handleCallback.mockResolvedValue({ outcome: 'connected' });
        const req = { query: { code: 'C', state: 'S' } };
        const res = makeRes();
        await controller.handleCallback(req, res, jest.fn());
        expect(service.handleCallback).toHaveBeenCalledWith({ code: 'C', state: 'S', error: undefined });
        expect(res.redirect).toHaveBeenCalledWith(302, 'http://localhost:5173/profile?jira=connected');
    });

    test('outcome cancelled → redirect a /profile?jira=cancelled', async () => {
        service.handleCallback.mockResolvedValue({ outcome: 'cancelled' });
        const req = { query: { error: 'access_denied' } };
        const res = makeRes();
        await controller.handleCallback(req, res, jest.fn());
        expect(res.redirect).toHaveBeenCalledWith(302, 'http://localhost:5173/profile?jira=cancelled');
    });

    test('outcome error → redirect a /profile?jira=error&reason=invalid_state', async () => {
        service.handleCallback.mockResolvedValue({ outcome: 'error', reason: 'invalid_state' });
        const req = { query: { code: 'C', state: 'S' } };
        const res = makeRes();
        await controller.handleCallback(req, res, jest.fn());
        expect(res.redirect).toHaveBeenCalledWith(302, 'http://localhost:5173/profile?jira=error&reason=invalid_state');
    });

    test('descarta params demasiado largos o no-string antes de pasarlos al service', async () => {
        service.handleCallback.mockResolvedValue({ outcome: 'error', reason: 'invalid_state' });
        const req = { query: { code: 'x'.repeat(3000), state: 12345 } };
        const res = makeRes();
        await controller.handleCallback(req, res, jest.fn());
        expect(service.handleCallback).toHaveBeenCalledWith({ code: undefined, state: undefined, error: undefined });
    });

    test('error inesperado → next(error)', async () => {
        const boom = new Error('boom');
        service.handleCallback.mockRejectedValue(boom);
        const req = { query: {} };
        const res = makeRes();
        const next = jest.fn();
        await controller.handleCallback(req, res, next);
        expect(next).toHaveBeenCalledWith(boom);
    });
});

describe('jira.controller — getStatus', () => {
    test('200 con el estado', async () => {
        service.getStatus.mockResolvedValue({ connected: false, siteUrl: null, lastSyncAt: null, reconnectRequired: false });
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        await controller.getStatus(req, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ connected: false, siteUrl: null, lastSyncAt: null, reconnectRequired: false });
    });

    test('sin req.user → next con error 401', async () => {
        const req = {};
        const res = makeRes();
        const next = jest.fn();
        await controller.getStatus(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'unauthenticated' }));
        expect(service.getStatus).not.toHaveBeenCalled();
    });

    test('error del service (p.ej. user_not_found) → next(error)', async () => {
        const err = Object.assign(new Error('nope'), { status: 404 });
        service.getStatus.mockRejectedValue(err);
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        const next = jest.fn();
        await controller.getStatus(req, res, next);
        expect(next).toHaveBeenCalledWith(err);
    });
});

describe('jira.controller — disconnect', () => {
    test('204 sin body', async () => {
        service.disconnect.mockResolvedValue();
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        await controller.disconnect(req, res, jest.fn());
        expect(service.disconnect).toHaveBeenCalledWith('u1', { source: 'self' });
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.send).toHaveBeenCalled();
    });

    test('sin req.user → next con error 401', async () => {
        const req = {};
        const res = makeRes();
        const next = jest.fn();
        await controller.disconnect(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'unauthenticated' }));
        expect(service.disconnect).not.toHaveBeenCalled();
    });
});

describe('jira.controller — triggerSync', () => {
    test('200 con el resumen del sync', async () => {
        service.syncForUser.mockResolvedValue({ imported: 3, skippedDuplicates: 1, durationMs: 12 });
        const req = { user: { id: 'u1' }, body: { dateStart: '2026-05-10T09:00:00Z', dateEnd: '2026-05-10T18:00:00Z' } };
        const res = makeRes();
        await controller.triggerSync(req, res, jest.fn());
        expect(service.syncForUser).toHaveBeenCalledWith('u1', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ imported: 3, skippedDuplicates: 1, durationMs: 12 });
    });

    test('sin req.user → next con error 401', async () => {
        const req = {};
        const res = makeRes();
        const next = jest.fn();
        await controller.triggerSync(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'unauthenticated' }));
        expect(service.syncForUser).not.toHaveBeenCalled();
    });

    test('body ausente → llama al service con undefined (el service valida la ventana)', async () => {
        service.syncForUser.mockRejectedValue(Object.assign(new Error('ventana inválida'), { status: 400 }));
        const req = { user: { id: 'u1' } };
        const res = makeRes();
        const next = jest.fn();
        await controller.triggerSync(req, res, next);
        expect(service.syncForUser).toHaveBeenCalledWith('u1', undefined, undefined);
        expect(next).toHaveBeenCalled();
    });
});

describe('jira.routes', () => {
    test('exporta un router de express con las rutas montadas', () => {
        const router = require('../../../src/modules/jira/jira.routes');
        expect(typeof router).toBe('function');
        const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
        expect(paths).toEqual(expect.arrayContaining([
            'GET /auth',
            'GET /auth/callback',
            'GET /status',
            'DELETE /connection',
            'POST /sync',
        ]));
    });
});
