jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
}));

jest.mock('../../../src/shared/utils/crypto', () => ({
    decrypt: jest.fn().mockReturnValue('decrypted-refresh-token'),
}));

jest.mock('../../../src/shared/utils/logger', () => ({
    warn: jest.fn(),
    error: jest.fn(),
}));

// El middleware crea un OAuth2Client nuevo por request (buildGoogleClient).
// Como el mock devuelve siempre la misma instancia, podemos controlar
// getAccessToken/setCredentials desde mockInstance en todos los tests.
jest.mock('google-auth-library', () => {
    const mockInstance = {
        setCredentials: jest.fn(),
        getAccessToken: jest.fn(),
    };
    const MockOAuth2Client = jest.fn(() => mockInstance);
    MockOAuth2Client.mockInstance = mockInstance;
    return { OAuth2Client: MockOAuth2Client };
});

const { OAuth2Client } = require('google-auth-library');
const mockGoogleClient = OAuth2Client.mockInstance;

const prisma = require('../../../src/shared/database/prisma');
const requireValidGoogleToken = require('../../../src/shared/middleware/requireValidGoogleToken');

const USER_OK = { refreshToken: 'encrypted-token', googleReconnectRequired: false };

let req, res, next;

beforeEach(() => {
    jest.clearAllMocks();
    req = { user: { id: 'user-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    prisma.user.update.mockResolvedValue({});
});

describe('requireValidGoogleToken', () => {
    test('responde 401 si req.user no está definido', async () => {
        req.user = null;

        await requireValidGoogleToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('responde 401 si el usuario no tiene refreshToken en BD', async () => {
        prisma.user.findUnique.mockResolvedValue({ refreshToken: null, googleReconnectRequired: false });

        await requireValidGoogleToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(mockGoogleClient.getAccessToken).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    test('responde 401 sin llamar a getAccessToken si googleReconnectRequired ya es true', async () => {
        prisma.user.findUnique.mockResolvedValue({ refreshToken: 'enc-token', googleReconnectRequired: true });

        await requireValidGoogleToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'google_auth_required' }));
        expect(mockGoogleClient.getAccessToken).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    test('llama a next() si getAccessToken tiene éxito', async () => {
        prisma.user.findUnique.mockResolvedValue(USER_OK);
        mockGoogleClient.getAccessToken.mockResolvedValue({ token: 'access-token' });

        await requireValidGoogleToken(req, res, next);

        expect(next).toHaveBeenCalledWith();
        expect(res.status).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('activa googleReconnectRequired y responde 401 cuando getAccessToken lanza invalid_grant', async () => {
        prisma.user.findUnique.mockResolvedValue(USER_OK);
        mockGoogleClient.getAccessToken.mockRejectedValue(new Error('invalid_grant'));

        await requireValidGoogleToken(req, res, next);

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { googleReconnectRequired: true },
        });
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'google_auth_required' }));
        expect(next).not.toHaveBeenCalled();
    });

    test('activa googleReconnectRequired y responde 401 cuando Google devuelve status 401', async () => {
        prisma.user.findUnique.mockResolvedValue(USER_OK);
        const googleError = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
        mockGoogleClient.getAccessToken.mockRejectedValue(googleError);

        await requireValidGoogleToken(req, res, next);

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { googleReconnectRequired: true },
        });
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('responde 401 aunque falle el update en BD al marcar el flag', async () => {
        prisma.user.findUnique.mockResolvedValue(USER_OK);
        mockGoogleClient.getAccessToken.mockRejectedValue(new Error('invalid_grant'));
        prisma.user.update.mockRejectedValue(new Error('DB caída'));

        await requireValidGoogleToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'google_auth_required' }));
        expect(next).not.toHaveBeenCalled();
    });

    test('llama a next(error) para errores que no son de autenticación de Google', async () => {
        prisma.user.findUnique.mockResolvedValue(USER_OK);
        const networkError = new Error('Network timeout');
        mockGoogleClient.getAccessToken.mockRejectedValue(networkError);

        await requireValidGoogleToken(req, res, next);

        expect(next).toHaveBeenCalledWith(networkError);
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });
});
