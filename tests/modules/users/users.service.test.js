jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
}));

const { loginGoogleUser, UnauthorizedUserError } = require('../../../src/modules/users/users.service');
const prisma = require('../../../src/shared/database/prisma');

const BASE_GOOGLE_DATA = {
    email: 'jperez@finnegans.com.ar',
    googleId: '123456789',
    fullName: 'Juan Pérez',
};

const ACTIVE_USER = {
    id: 'uuid-1',
    email: 'jperez@finnegans.com.ar',
    fullName: 'Juan Pérez',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    refreshToken: null,
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Servicio de Usuarios (loginGoogleUser)', () => {
    test('Lanza UnauthorizedUserError si el usuario no existe en la BD', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(loginGoogleUser(BASE_GOOGLE_DATA, null)).rejects.toThrow(UnauthorizedUserError);
    });

    test('Lanza UnauthorizedUserError si el usuario está INACTIVE', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...ACTIVE_USER, status: 'INACTIVE' });

        await expect(loginGoogleUser(BASE_GOOGLE_DATA, null)).rejects.toThrow(UnauthorizedUserError);
    });

    test('Actualiza googleId y fullName cuando el usuario existe y está activo', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);

        await loginGoogleUser(BASE_GOOGLE_DATA, null);

        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { email: 'jperez@finnegans.com.ar' },
                data: expect.objectContaining({
                    googleId: '123456789',
                    fullName: 'Juan Pérez',
                }),
            })
        );
    });

    test('Incluye refreshToken en el update cuando se proporciona', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);
        const encryptedToken = 'aabbcc:ddeeff:112233';

        await loginGoogleUser(BASE_GOOGLE_DATA, encryptedToken);

        const callArgs = prisma.user.update.mock.calls[0][0];
        expect(callArgs.data.refreshToken).toBe(encryptedToken);
    });

    test('NO incluye refreshToken en el update cuando no se proporciona', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);

        await loginGoogleUser(BASE_GOOGLE_DATA, null);

        const callArgs = prisma.user.update.mock.calls[0][0];
        expect(callArgs.data).not.toHaveProperty('refreshToken');
    });

    test('Normaliza el email a lowercase y sin espacios', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);

        await loginGoogleUser({ ...BASE_GOOGLE_DATA, email: '  JPerez@Finnegans.COM.ar  ' }, null);

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
            where: { email: 'jperez@finnegans.com.ar' },
        });
    });

    test('Retorna el usuario devuelto por Prisma', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);

        const result = await loginGoogleUser(BASE_GOOGLE_DATA, null);

        expect(result).toEqual(ACTIVE_USER);
    });

    test('Lanza error si email es undefined', async () => {
        await expect(
            loginGoogleUser({ googleId: '123', fullName: 'Juan' }, null)
        ).rejects.toThrow('email y googleId son requeridos');
    });

    test('Lanza error si googleId es undefined', async () => {
        await expect(
            loginGoogleUser({ email: 'a@a.com', fullName: 'Juan' }, null)
        ).rejects.toThrow('email y googleId son requeridos');
    });
});
