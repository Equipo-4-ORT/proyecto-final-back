process.env.ADMIN_SECRET_KEY = 'test-admin-secret-key';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
process.env.JWT_SECRET = 'test-jwt-secret';

jest.mock('jsonwebtoken');
jest.mock('../../../src/modules/google/google.service', () => ({
    verifyGoogleToken: jest.fn(),
}));
jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn()
    }
}));
jest.mock('../../../src/modules/users/users.service', () => ({
    upsertGoogleUser: jest.fn(),
}));
jest.mock('../../../src/shared/utils/crypto', () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
}));

jest.mock('google-auth-library', () => {
    const mockInstance = {
        generateAuthUrl: jest.fn(),
        getToken: jest.fn(),
    };
    const MockOAuth2Client = jest.fn(() => mockInstance);
    MockOAuth2Client.mockInstance = mockInstance;
    return { OAuth2Client: MockOAuth2Client };
});

const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { verifyGoogleToken } = require('../../../src/modules/google/google.service');
const { upsertGoogleUser } = require('../../../src/modules/users/users.service');
const { encrypt } = require('../../../src/shared/utils/crypto');
const prisma = require('../../../src/shared/database/prisma');

const {
    asignarRol,
    InvalidAdminKeyError,
    InsufficientScopesError,
    UserNotActiveError,
    getGoogleAuthUrl,
    handleGoogleCallback,
    generateJWT,
} = require('../../../src/modules/auth/auth.service');

const mockClient = OAuth2Client.mockInstance;

const FULL_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/documents',
].join(' ');

describe('Auth Service', () => {
    beforeAll(() => {
        jest.useFakeTimers();
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── asignarRol ───────────────────────────────────────────────────────────
    describe('asignarRol()', () => {
        test('Sin llave devuelve EMPLOYEE', () => {
            expect(asignarRol(undefined)).toBe('EMPLOYEE');
            expect(asignarRol(null)).toBe('EMPLOYEE');
            expect(asignarRol('')).toBe('EMPLOYEE');
        });

        test('Con llave válida devuelve ADMIN', () => {
            expect(asignarRol('test-admin-secret-key')).toBe('ADMIN');
        });

        test('Con llave inválida lanza InvalidAdminKeyError', () => {
            expect(() => asignarRol('wrong-key')).toThrow(InvalidAdminKeyError);
            expect(() => asignarRol('wrong-key')).toThrow('Llave de admin inválida');
        });
    });

    // ── generateJWT ──────────────────────────────────────────────────────────
    describe('generateJWT()', () => {
        test('Firma el JWT con sub, email y role', () => {
            jwt.sign.mockReturnValue('mock-token');
            const user = { id: 'uuid-1', email: 'user@test.com', role: 'EMPLOYEE' };

            const token = generateJWT(user);

            expect(token).toBe('mock-token');
            expect(jwt.sign).toHaveBeenCalledWith(
                { sub: 'uuid-1', email: 'user@test.com', role: 'EMPLOYEE' },
                process.env.JWT_SECRET,
                expect.objectContaining({ expiresIn: expect.any(String) })
            );
        });
    });

    // ── getGoogleAuthUrl ─────────────────────────────────────────────────────
    describe('getGoogleAuthUrl()', () => {
        test('Devuelve la URL generada por OAuth2Client', () => {
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');

            const url = getGoogleAuthUrl();

            expect(url).toBe('https://accounts.google.com/mock');
            expect(mockClient.generateAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({
                    access_type: 'offline',
                    prompt: 'consent',
                    state: expect.any(String),
                })
            );
        });

        test('Genera un state distinto en cada llamada', () => {
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');

            getGoogleAuthUrl();
            getGoogleAuthUrl();

            const state1 = mockClient.generateAuthUrl.mock.calls[0][0].state;
            const state2 = mockClient.generateAuthUrl.mock.calls[1][0].state;
            expect(state1).not.toBe(state2);
        });
    });

    // ── handleGoogleCallback ─────────────────────────────────────────────────
    describe('handleGoogleCallback()', () => {
        test('Lanza error si el state es inválido', async () => {
            await expect(
                handleGoogleCallback('code', 'state-que-no-existe')
            ).rejects.toThrow('State inválido o expirado');
        });

        test('Lanza error si el state está vacío', async () => {
            await expect(
                handleGoogleCallback('code', null)
            ).rejects.toThrow('State inválido o expirado');
        });

        test('Lanza InsufficientScopesError si el usuario no otorgó todos los permisos', async () => {
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');
            getGoogleAuthUrl();
            const { state } = mockClient.generateAuthUrl.mock.calls[0][0];

            mockClient.getToken.mockResolvedValue({
                tokens: { id_token: 'tok', refresh_token: null, scope: 'openid email' },
            });

            await expect(handleGoogleCallback('code', state)).rejects.toThrow(InsufficientScopesError);
        });

        test('Flujo exitoso: verifica token, encripta refresh, crea usuario y devuelve JWT', async () => {
            prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');
            getGoogleAuthUrl();
            const { state } = mockClient.generateAuthUrl.mock.calls[0][0];

            const mockUser = { id: 'uuid-1', email: 'user@test.com', role: 'EMPLOYEE' };
            mockClient.getToken.mockResolvedValue({
                tokens: { id_token: 'id-tok', refresh_token: 'refresh-tok', scope: FULL_SCOPES },
            });
            verifyGoogleToken.mockResolvedValue({ email: 'user@test.com', googleId: '123', fullName: 'User' });
            encrypt.mockReturnValue('encrypted-refresh');
            upsertGoogleUser.mockResolvedValue(mockUser);
            jwt.sign.mockReturnValue('signed-jwt');

            const result = await handleGoogleCallback('auth-code', state);

            expect(result).toBe('signed-jwt');
            expect(verifyGoogleToken).toHaveBeenCalledWith('id-tok');
            expect(encrypt).toHaveBeenCalledWith('refresh-tok');
            expect(upsertGoogleUser).toHaveBeenCalledWith(
                expect.objectContaining({ email: 'user@test.com' }),
                'encrypted-refresh'
            );
        });

        test('Guarda null como refreshToken si Google no devuelve uno', async () => {
            prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');
            getGoogleAuthUrl();
            const { state } = mockClient.generateAuthUrl.mock.calls[0][0];

            mockClient.getToken.mockResolvedValue({
                tokens: { id_token: 'id-tok', refresh_token: null, scope: FULL_SCOPES },
            });
            verifyGoogleToken.mockResolvedValue({ email: 'user@test.com', googleId: '123', fullName: 'User' });
            upsertGoogleUser.mockResolvedValue({ id: 'uuid-1', email: 'user@test.com', role: 'EMPLOYEE' });
            jwt.sign.mockReturnValue('signed-jwt');

            await handleGoogleCallback('auth-code', state);

            expect(encrypt).not.toHaveBeenCalled();
            expect(upsertGoogleUser).toHaveBeenCalledWith(expect.any(Object), null);
        });

        test('El state queda consumido y no puede usarse dos veces', async () => {
            prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
            mockClient.generateAuthUrl.mockReturnValue('https://accounts.google.com/mock');
            getGoogleAuthUrl();
            const { state } = mockClient.generateAuthUrl.mock.calls[0][0];

            mockClient.getToken.mockResolvedValue({
                tokens: { id_token: 'id-tok', refresh_token: null, scope: FULL_SCOPES },
            });
            verifyGoogleToken.mockResolvedValue({ email: 'u@t.com', googleId: '1', fullName: 'U' });
            upsertGoogleUser.mockResolvedValue({ id: '1', email: 'u@t.com', role: 'EMPLOYEE' });
            jwt.sign.mockReturnValue('jwt');

            await handleGoogleCallback('code', state);

            await expect(handleGoogleCallback('code', state)).rejects.toThrow('State inválido o expirado');
        });
    });
});
