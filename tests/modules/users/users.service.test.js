jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        upsert: jest.fn(),
    },
}));

const { upsertGoogleUser } = require('../../../src/modules/users/users.service');
const prisma = require('../../../src/shared/database/prisma');

const BASE_GOOGLE_DATA = {
    email: 'jperez@finnegans.com.ar',
    googleId: '123456789',
    fullName: 'Juan Pérez',
};

describe('Servicio de Usuarios (upsertGoogleUser)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.user.upsert.mockResolvedValue({
            id: 'uuid-1',
            email: 'jperez@finnegans.com.ar',
            googleId: '123456789',
            fullName: 'Juan Pérez',
            role: 'EMPLOYEE',
            refreshToken: null,
        });
    });

    test('Debe crear el usuario con los campos correctos cuando no hay refreshToken', async () => {
        await upsertGoogleUser(BASE_GOOGLE_DATA, null);

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { email: 'jperez@finnegans.com.ar' },
                create: expect.objectContaining({
                    email: 'jperez@finnegans.com.ar',
                    googleId: '123456789',
                    fullName: 'Juan Pérez',
                    refreshToken: null,
                }),
            })
        );
    });

    test('Debe incluir el refreshToken ya encriptado en create cuando se proporciona', async () => {
        const encryptedToken = 'aabbcc:ddeeff:112233';

        await upsertGoogleUser(BASE_GOOGLE_DATA, encryptedToken);

        const callArgs = prisma.user.upsert.mock.calls[0][0];
        expect(callArgs.create.refreshToken).toBe(encryptedToken);
    });

    test('Debe incluir el refreshToken en update cuando se proporciona', async () => {
        const encryptedToken = 'aabbcc:ddeeff:112233';

        await upsertGoogleUser(BASE_GOOGLE_DATA, encryptedToken);

        const callArgs = prisma.user.upsert.mock.calls[0][0];
        expect(callArgs.update.refreshToken).toBe(encryptedToken);
    });

    test('NO debe incluir refreshToken en update cuando no se proporciona', async () => {
        await upsertGoogleUser(BASE_GOOGLE_DATA, null);

        const callArgs = prisma.user.upsert.mock.calls[0][0];
        expect(callArgs.update).not.toHaveProperty('refreshToken');
    });

    test('NO debe setear role en create — lo define el default de Prisma', async () => {
        await upsertGoogleUser(BASE_GOOGLE_DATA, null);

        const callArgs = prisma.user.upsert.mock.calls[0][0];
        expect(callArgs.create).not.toHaveProperty('role');
    });

    test('Debe normalizar el email a lowercase y sin espacios', async () => {
        await upsertGoogleUser(
            { ...BASE_GOOGLE_DATA, email: '  JPerez@Finnegans.COM.ar  ' },
            null
        );

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { email: 'jperez@finnegans.com.ar' },
                create: expect.objectContaining({ email: 'jperez@finnegans.com.ar' }),
            })
        );
    });

    test('Debe lanzar error si email es undefined', async () => {
        await expect(
            upsertGoogleUser({ googleId: '123', fullName: 'Juan' }, null)
        ).rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error si googleId es undefined', async () => {
        await expect(
            upsertGoogleUser({ email: 'a@a.com', fullName: 'Juan' }, null)
        ).rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error controlado si la BD falla', async () => {
        prisma.user.upsert.mockRejectedValue(new Error('Conexión perdida'));

        await expect(
            upsertGoogleUser(BASE_GOOGLE_DATA, null)
        ).rejects.toThrow('No se pudo guardar el usuario en la base de datos');
    });

    test('Debe retornar el usuario devuelto por Prisma', async () => {
        const mockUser = { id: 'uuid-1', email: 'jperez@finnegans.com.ar', role: 'EMPLOYEE' };
        prisma.user.upsert.mockResolvedValue(mockUser);

        const result = await upsertGoogleUser(BASE_GOOGLE_DATA, null);

        expect(result).toEqual(mockUser);
    });
});
