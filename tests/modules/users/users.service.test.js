jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
}));

const {
    loginGoogleUser,
    UnauthorizedUserError,
    getUserSettings,
    updateUserSettings,
    UserValidationError,
    UserNotFoundError,
} = require('../../../src/modules/users/users.service');
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

    test('Siempre resetea googleReconnectRequired a false en el update', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockResolvedValue(ACTIVE_USER);

        await loginGoogleUser(BASE_GOOGLE_DATA, null);

        const callArgs = prisma.user.update.mock.calls[0][0];
        expect(callArgs.data.googleReconnectRequired).toBe(false);
    });

    test('Lanza error controlado si la BD falla al actualizar', async () => {
        prisma.user.findUnique.mockResolvedValue(ACTIVE_USER);
        prisma.user.update.mockRejectedValue(new Error('Conexión perdida'));

        await expect(loginGoogleUser(BASE_GOOGLE_DATA, null)).rejects.toThrow('No se pudo actualizar el usuario');
    });
});

describe('Servicio de Usuarios (getUserSettings)', () => {
    test('Lanza UserNotFoundError si el usuario no existe', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(getUserSettings('uuid-1')).rejects.toThrow(UserNotFoundError);
    });

    test('Convierte defaultDuration de minutos (BD) a horas (API)', async () => {
        prisma.user.findUnique.mockResolvedValue({
            workStartTime: '09:00',
            workEndTime: '18:00',
            avoidOverlaps: false,
            defaultDuration: 120, // minutos en la BD
        });

        const settings = await getUserSettings('uuid-1');

        expect(settings.defaultDuration).toBe(2); // horas
    });
});

describe('Servicio de Usuarios (updateUserSettings - defaultDuration)', () => {
    const updatedRow = {
        workStartTime: '09:00',
        workEndTime: '18:00',
        avoidOverlaps: false,
        defaultDuration: 120,
    };

    test('Convierte horas a minutos antes de persistir', async () => {
        prisma.user.update.mockResolvedValue(updatedRow);

        await updateUserSettings('uuid-1', { defaultDuration: 2 });

        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { defaultDuration: 120 }, // 2 h -> 120 min
            })
        );
    });

    test('Acepta el mínimo (1 hora = 60 min)', async () => {
        prisma.user.update.mockResolvedValue({ ...updatedRow, defaultDuration: 60 });

        await updateUserSettings('uuid-1', { defaultDuration: 1 });

        expect(prisma.user.update.mock.calls[0][0].data.defaultDuration).toBe(60);
    });

    test('Acepta el máximo (24 horas = 1440 min)', async () => {
        prisma.user.update.mockResolvedValue({ ...updatedRow, defaultDuration: 1440 });

        await updateUserSettings('uuid-1', { defaultDuration: 24 });

        expect(prisma.user.update.mock.calls[0][0].data.defaultDuration).toBe(1440);
    });

    test('Devuelve defaultDuration en horas', async () => {
        prisma.user.update.mockResolvedValue(updatedRow);

        const result = await updateUserSettings('uuid-1', { defaultDuration: 2 });

        expect(result.defaultDuration).toBe(2);
    });

    test('Rechaza 0 horas (menor al mínimo)', async () => {
        await expect(
            updateUserSettings('uuid-1', { defaultDuration: 0 })
        ).rejects.toThrow(UserValidationError);
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('Rechaza 25 horas (mayor al máximo)', async () => {
        await expect(
            updateUserSettings('uuid-1', { defaultDuration: 25 })
        ).rejects.toThrow(UserValidationError);
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('Rechaza valores no enteros (doubles)', async () => {
        await expect(
            updateUserSettings('uuid-1', { defaultDuration: 1.5 })
        ).rejects.toThrow(UserValidationError);
        expect(prisma.user.update).not.toHaveBeenCalled();
    });
});
