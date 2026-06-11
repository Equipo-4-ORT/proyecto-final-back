// Errores reales para que los `instanceof` del controller funcionen.
jest.mock('../../../src/modules/auth/auth.service', () => {
    class InsufficientScopesError extends Error { constructor() { super('scopes'); this.name = 'InsufficientScopesError'; } }
    class UserNotActiveError extends Error { constructor(email) { super('not active'); this.name = 'UserNotActiveError'; this.email = email; } }
    class InvalidAdminKeyError extends Error { constructor() { super('key'); this.name = 'InvalidAdminKeyError'; } }
    class AdminAlreadyExistsError extends Error { constructor() { super('exists'); this.name = 'AdminAlreadyExistsError'; } }
    return {
        getGoogleAuthUrl: jest.fn().mockReturnValue('https://mock-google-url.com'),
        handleGoogleCallback: jest.fn(),
        bootstrapAdmin: jest.fn(),
        InsufficientScopesError,
        UserNotActiveError,
        InvalidAdminKeyError,
        AdminAlreadyExistsError,
    };
});

jest.mock('../../../src/modules/users/users.service', () => {
    class UnauthorizedUserError extends Error { constructor(email) { super('unauth'); this.name = 'UnauthorizedUserError'; this.email = email; } }
    return { UnauthorizedUserError };
});

jest.mock('../../../src/modules/auth/auth.tokens', () => ({
    generateRefreshToken: jest.fn(() => 'refresh-plano'),
    hashRefreshToken: jest.fn((p) => `hash(${p})`),
    signAccessToken: jest.fn(() => 'access-jwt'),
    refreshExpiresAt: jest.fn(() => new Date('2099-01-01T00:00:00Z')),
}));

jest.mock('../../../src/modules/auth/auth.cookies', () => ({
    setAccessCookie: jest.fn(),
    setRefreshCookie: jest.fn(),
    clearAuthCookies: jest.fn(),
}));

jest.mock('../../../src/shared/database/prisma', () => ({
    session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../src/shared/utils/logger', () => ({ warn: jest.fn(), error: jest.fn() }));

const {
    redirectToGoogle,
    googleCallback,
    refresh,
    logout,
    me,
    createBootstrapAdmin,
} = require('../../../src/modules/auth/auth.controller');
const authService = require('../../../src/modules/auth/auth.service');
const { UnauthorizedUserError } = require('../../../src/modules/users/users.service');
const cookies = require('../../../src/modules/auth/auth.cookies');
const prisma = require('../../../src/shared/database/prisma');
const logger = require('../../../src/shared/utils/logger');

const makeRes = () => ({
    redirect: jest.fn(),
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
});
const makeReq = (over = {}) => ({
    query: {},
    cookies: {},
    body: {},
    get: jest.fn().mockReturnValue('jest-UA'),
    ip: '127.0.0.1',
    header: jest.fn(),
    ...over,
});

describe('Auth Controller (cookies HttpOnly)', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.FRONTEND_BASE_URL = 'http://localhost:5173';
        req = makeReq();
        res = makeRes();
    });

    // ── redirectToGoogle ─────────────────────────────────────────────────────
    describe('redirectToGoogle()', () => {
        test('Redirige a la URL de Google', () => {
            redirectToGoogle(req, res);
            expect(authService.getGoogleAuthUrl).toHaveBeenCalledTimes(1);
            expect(res.redirect).toHaveBeenCalledWith('https://mock-google-url.com');
        });
    });

    // ── googleCallback ───────────────────────────────────────────────────────
    describe('googleCallback()', () => {
        test('access_denied → /login?error=access_denied', async () => {
            req.query = { error: 'access_denied' };
            await googleCallback(req, res);
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=access_denied');
            expect(authService.handleGoogleCallback).not.toHaveBeenCalled();
        });

        test('sin code → /login?error=missing_code', async () => {
            req.query = { state: 's' };
            await googleCallback(req, res);
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=missing_code');
        });

        test('éxito (EMPLOYEE) → crea sesión, setea cookies y redirige a /callback?redirect=/dashboard', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockResolvedValue({ id: 'u1', email: 'emp@b.com', role: 'EMPLOYEE' });

            await googleCallback(req, res);

            expect(authService.handleGoogleCallback).toHaveBeenCalledWith('c', 's');
            expect(prisma.session.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    userId: 'u1',
                    refreshTokenHash: 'hash(refresh-plano)',
                    userAgent: 'jest-UA',
                    ip: '127.0.0.1',
                }),
            });
            expect(cookies.setAccessCookie).toHaveBeenCalledWith(res, 'access-jwt');
            expect(cookies.setRefreshCookie).toHaveBeenCalledWith(res, 'refresh-plano');
            // El backend indica al front el destino según el rol
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/callback?redirect=/dashboard');
            // No debe haber ?token= en ninguna redirección
            expect(res.redirect.mock.calls.every(([url]) => !url.includes('token='))).toBe(true);
        });

        test('éxito (ADMIN) → redirige a /callback?redirect=/admin', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockResolvedValue({ id: 'u2', email: 'admin@b.com', role: 'ADMIN' });

            await googleCallback(req, res);

            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/callback?redirect=/admin');
        });

        test('rol desconocido → cae al destino por defecto /dashboard', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockResolvedValue({ id: 'u3', email: 'x@b.com', role: 'UNKNOWN' });

            await googleCallback(req, res);

            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/callback?redirect=/dashboard');
        });

        test('InsufficientScopesError → /login?error=insufficient_scopes', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockRejectedValue(new authService.InsufficientScopesError());
            await googleCallback(req, res);
            expect(logger.warn).toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=insufficient_scopes');
        });

        test('UserNotActiveError → /login?error=unauthorized_user', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockRejectedValue(new authService.UserNotActiveError('a@b.com'));
            await googleCallback(req, res);
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=unauthorized_user');
        });

        test('UnauthorizedUserError → /login?error=unauthorized_user (FRONTEND_BASE_URL, no FRONTEND_URL)', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockRejectedValue(new UnauthorizedUserError('a@b.com'));
            await googleCallback(req, res);
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=unauthorized_user');
        });

        test('error genérico → /login?error=auth_failed', async () => {
            req.query = { code: 'c', state: 's' };
            authService.handleGoogleCallback.mockRejectedValue(new Error('DB down'));
            await googleCallback(req, res);
            expect(logger.error).toHaveBeenCalled();
            expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/login?error=auth_failed');
        });
    });

    // ── refresh ──────────────────────────────────────────────────────────────
    describe('refresh()', () => {
        test('sin cookie → 401 no_refresh', async () => {
            await refresh(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'no_refresh' });
        });

        test('sesión inexistente → limpia cookies y 401 invalid_refresh', async () => {
            req.cookies.refresh_token = 'plano';
            prisma.session.findUnique.mockResolvedValue(null);
            await refresh(req, res);
            expect(cookies.clearAuthCookies).toHaveBeenCalledWith(res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'invalid_refresh' });
        });

        test('refresh ya revocado (reuse) → revoca TODAS las sesiones del user + 401', async () => {
            req.cookies.refresh_token = 'viejo';
            prisma.session.findUnique.mockResolvedValue({
                id: 's1', userId: 'u1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 1000),
                user: { status: 'ACTIVE' },
            });
            await refresh(req, res);
            expect(prisma.session.updateMany).toHaveBeenCalledWith({
                where: { userId: 'u1', revokedAt: null },
                data: { revokedAt: expect.any(Date) },
            });
            expect(logger.warn).toHaveBeenCalled();
            expect(cookies.clearAuthCookies).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('sesión expirada → 401 sin revocación masiva', async () => {
            req.cookies.refresh_token = 'exp';
            prisma.session.findUnique.mockResolvedValue({
                id: 's1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() - 1000),
                user: { status: 'ACTIVE' },
            });
            await refresh(req, res);
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('usuario no ACTIVE → 403 user_not_active', async () => {
            req.cookies.refresh_token = 'ok';
            prisma.session.findUnique.mockResolvedValue({
                id: 's1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 100000),
                user: { status: 'INACTIVE' },
            });
            await refresh(req, res);
            expect(cookies.clearAuthCookies).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ error: 'user_not_active' });
        });

        test('flujo OK → rota en transacción, setea cookies nuevas y { ok: true }', async () => {
            req.cookies.refresh_token = 'actual';
            prisma.session.findUnique.mockResolvedValue({
                id: 's1', userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() + 100000),
                user: { id: 'u1', email: 'a@b.com', role: 'EMPLOYEE', status: 'ACTIVE' },
            });
            await refresh(req, res);
            expect(prisma.$transaction).toHaveBeenCalledTimes(1);
            expect(prisma.session.update).toHaveBeenCalledWith({
                where: { id: 's1' },
                data: { revokedAt: expect.any(Date) },
            });
            expect(prisma.session.create).toHaveBeenCalled();
            expect(cookies.setAccessCookie).toHaveBeenCalledWith(res, 'access-jwt');
            expect(cookies.setRefreshCookie).toHaveBeenCalledWith(res, 'refresh-plano');
            expect(res.json).toHaveBeenCalledWith({ ok: true });
        });
    });

    // ── logout ───────────────────────────────────────────────────────────────
    describe('logout()', () => {
        test('con cookie → revoca la sesión actual y limpia cookies', async () => {
            req.cookies.refresh_token = 'plano';
            await logout(req, res);
            expect(prisma.session.updateMany).toHaveBeenCalledWith({
                where: { refreshTokenHash: 'hash(plano)', revokedAt: null },
                data: { revokedAt: expect.any(Date) },
            });
            expect(cookies.clearAuthCookies).toHaveBeenCalledWith(res);
            expect(res.json).toHaveBeenCalledWith({ ok: true });
        });

        test('sin cookie → solo limpia cookies (no toca DB)', async () => {
            await logout(req, res);
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(cookies.clearAuthCookies).toHaveBeenCalledWith(res);
            expect(res.json).toHaveBeenCalledWith({ ok: true });
        });
    });

    // ── me ───────────────────────────────────────────────────────────────────
    describe('me()', () => {
        test('devuelve { user: req.user }', async () => {
            req.user = { id: 'u1', email: 'a@b.com', role: 'ADMIN', status: 'ACTIVE' };
            await me(req, res);
            expect(res.json).toHaveBeenCalledWith({ user: req.user });
        });
    });

    // ── createBootstrapAdmin ───────────────────────────────────────────────────
    // ── createBootstrapAdmin ───────────────────────────────────────────────────
    describe('createBootstrapAdmin()', () => {
        test('400 si falla validación de Zod (falta email)', async () => {
            req.header = jest.fn().mockReturnValue('key');
            req.body = { fullName: 'Admin Valido' }; // Falta email para que Zod falle
            await createBootstrapAdmin(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
        });

        test('201 con admin creado', async () => {
            req.header = jest.fn().mockReturnValue('key');
            req.body = { email: 'admin@dominio.com', fullName: 'Admin Valido' }; // Datos válidos para Zod
            authService.bootstrapAdmin.mockResolvedValue({ id: 'a1', email: 'admin@dominio.com', role: 'ADMIN' });
            await createBootstrapAdmin(req, res);
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                admin: expect.objectContaining({ email: 'admin@dominio.com', role: 'ADMIN' }),
            }));
        });

        test('401 si InvalidAdminKeyError', async () => {
            req.header = jest.fn().mockReturnValue('bad');
            req.body = { email: 'admin@dominio.com', fullName: 'Admin Valido' }; // Datos válidos para Zod
            authService.bootstrapAdmin.mockRejectedValue(new authService.InvalidAdminKeyError());
            await createBootstrapAdmin(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
        });

        test('409 si AdminAlreadyExistsError', async () => {
            req.header = jest.fn().mockReturnValue('key');
            req.body = { email: 'admin@dominio.com', fullName: 'Admin Valido' }; // Datos válidos para Zod
            authService.bootstrapAdmin.mockRejectedValue(new authService.AdminAlreadyExistsError());
            await createBootstrapAdmin(req, res);
            expect(res.status).toHaveBeenCalledWith(409);
        });
    });
});
