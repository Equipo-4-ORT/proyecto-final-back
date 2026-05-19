jest.mock('../../../src/modules/auth/auth.service', () => {
    class InsufficientScopesError extends Error {
        constructor() { super('Insufficient scopes'); this.name = 'InsufficientScopesError'; }
    }
    // Agregamos la simulación del nuevo error
    class UserNotActiveError extends Error {
        constructor(email) { super('Not active'); this.name = 'UserNotActiveError'; this.email = email;}
    }
    return {
        getGoogleAuthUrl: jest.fn().mockReturnValue('https://mock-google-url.com'),
        handleGoogleCallback: jest.fn(),
        InsufficientScopesError,
        UserNotActiveError, // Exportamos el error
    };
});
jest.mock('../../../src/shared/utils/logger', () => ({
    warn: jest.fn(),
    error: jest.fn(),
}));

const { redirectToGoogle, googleCallback } = require('../../../src/modules/auth/auth.controller');
const { getGoogleAuthUrl, handleGoogleCallback, InsufficientScopesError, UserNotActiveError } = require('../../../src/modules/auth/auth.service');
const logger = require('../../../src/shared/utils/logger');

describe('Auth Controller', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FRONTEND_URL = 'http://localhost:5173';
        req = { query: {} };
        res = { redirect: jest.fn() };
    });

    // ── redirectToGoogle ─────────────────────────────────────────────────────
    describe('redirectToGoogle()', () => {
        test('Redirige a la URL de Google generada por auth.service', () => {
            redirectToGoogle(req, res);

            expect(getGoogleAuthUrl).toHaveBeenCalledTimes(1);
            expect(res.redirect).toHaveBeenCalledWith('https://mock-google-url.com');
        });
    });

    // ── googleCallback ───────────────────────────────────────────────────────
    describe('googleCallback()', () => {
        test('Redirige a login?error=access_denied si el usuario canceló en Google', async () => {
            req.query = { error: 'access_denied' };

            await googleCallback(req, res);

            expect(res.redirect).toHaveBeenCalledWith(
                'http://localhost:5173/login?error=access_denied'
            );
            expect(handleGoogleCallback).not.toHaveBeenCalled();
        });

        test('Redirige a login?error=missing_code si no hay code en el query', async () => {
            req.query = { state: 'valid-state' };

            await googleCallback(req, res);

            expect(res.redirect).toHaveBeenCalledWith(
                'http://localhost:5173/login?error=missing_code'
            );
        });

        test('Redirige a /callback?token= con el JWT en el flujo exitoso', async () => {
            req.query = { code: 'valid-code', state: 'valid-state' };
            handleGoogleCallback.mockResolvedValue('mock-jwt-token');

            await googleCallback(req, res);

            expect(handleGoogleCallback).toHaveBeenCalledWith('valid-code', 'valid-state');
            expect(res.redirect).toHaveBeenCalledWith(
                'http://localhost:5173/callback?token=mock-jwt-token'
            );
        });

        test('Redirige a login?error=insufficient_scopes si el usuario no otorgó todos los permisos', async () => {
            req.query = { code: 'valid-code', state: 'valid-state' };
            handleGoogleCallback.mockRejectedValue(new InsufficientScopesError());

            await googleCallback(req, res);

            expect(logger.warn).toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith(
                'http://localhost:5173/login?error=insufficient_scopes'
            );
        });

        test('Redirige a login?error=auth_failed ante cualquier error genérico', async () => {
            req.query = { code: 'valid-code', state: 'valid-state' };
            handleGoogleCallback.mockRejectedValue(new Error('DB connection failed'));

            await googleCallback(req, res);

            expect(logger.error).toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith(
                'http://localhost:5173/login?error=auth_failed'
            );
        });
    });
});
