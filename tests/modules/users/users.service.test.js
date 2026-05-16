const nodeCrypto = require('crypto');

// La key DEBE setearse ANTES del require de users.service
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');

// ← IMPORTANTE: Mock ANTES de los requires
jest.mock('../../../src/modules/auth/auth.service', () => {
    class InvalidAdminKeyError extends Error {
        constructor(msg) { super(msg); this.name = 'InvalidAdminKeyError'; }
    }
    return { asignarRol: jest.fn(), InvalidAdminKeyError };
});

jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        upsert: jest.fn(),
    },
}));

// ← DESPUÉS de los mocks, hacer los imports
const { upsertGoogleUser } = require('../../../src/modules/users/users.service');
const { asignarRol, InvalidAdminKeyError } = require('../../../src/modules/auth/auth.service');
const prisma = require('../../../src/shared/database/prisma');


describe('Servicio de Usuarios (upsertGoogleUser)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Sin llave de admin debe asignar rol EMPLOYEE', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockResolvedValue({ id: 1, role: 'EMPLOYEE', email: 'jperez@finnegans.com.ar', googleId: '123', fullName: 'Juan' });

        await upsertGoogleUser({
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan'
        }, undefined);

        expect(asignarRol).toHaveBeenCalledWith(undefined);
        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ role: 'EMPLOYEE' })
            })
        );
    });

    test('Con llave válida debe asignar rol ADMIN', async () => {
        asignarRol.mockReturnValue('ADMIN');
        prisma.user.upsert.mockResolvedValue({ id: 1, role: 'ADMIN', email: 'admin@finnegans.com.ar', googleId: '456', fullName: 'Admin' });

        await upsertGoogleUser({
            email: 'admin@finnegans.com.ar',
            googleId: '456',
            fullName: 'Admin'
        }, 'admin-secret-key-default');

        expect(asignarRol).toHaveBeenCalledWith('admin-secret-key-default');
        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ role: 'ADMIN' })
            })
        );
    });

    test('Con llave inválida debe lanzar error', async () => {
        asignarRol.mockImplementation(() => {
            throw new InvalidAdminKeyError('Llave de admin inválida');
        });

        await expect(upsertGoogleUser({
            email: 'test@finnegans.com.ar',
            googleId: '789',
            fullName: 'Test'
        }, 'llave-incorrecta')).rejects.toThrow('Llave de admin inválida');

        expect(asignarRol).toHaveBeenCalledWith('llave-incorrecta');
    });

    test('Debe normalizar el email a lowercase y trim', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockResolvedValue({});

        await upsertGoogleUser({
            email: '  JPerez@Finnegans.COM.ar  ',
            googleId: '123',
            fullName: 'Juan'
        }, undefined);

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { email: 'jperez@finnegans.com.ar' },
                create: expect.objectContaining({ email: 'jperez@finnegans.com.ar' }),
            })
        );
    });

    test('Debe lanzar error si email es undefined', async () => {
        await expect(upsertGoogleUser({ googleId: '123', fullName: 'Juan' }, undefined))
            .rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error si googleId es undefined', async () => {
        await expect(upsertGoogleUser({ email: 'a@a.com', fullName: 'Juan' }, undefined))
            .rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error controlado si la BD falla', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockRejectedValue(new Error('Conexión perdida'));

        await expect(upsertGoogleUser({ email: 'error@test.com', googleId: '000', fullName: 'Error' }, undefined))
            .rejects.toThrow('No se pudo guardar el usuario en la base de datos');
    });

    // ==================== TESTS PARA ENCRIPTACIÓN (F1-03.3) ====================

    test('Debe encriptar el refreshToken si está presente', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockResolvedValue({
            id: 1,
            role: 'EMPLOYEE',
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan',
            refreshToken: 'encrypted_token_here'
        });

        const refreshToken = 'google_refresh_token_abc123';

        await upsertGoogleUser({
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan',
            refreshToken
        }, undefined);

        const callArgs = prisma.user.upsert.mock.calls[0][0];

        // Verificar que se encriptó (formato: "iv:authTag:encrypted")
        expect(callArgs.create.refreshToken).toBeDefined();
        expect(callArgs.create.refreshToken).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
        expect(callArgs.create.refreshToken).not.toBe(refreshToken);
    });

    test('Debe permitir guardar sin refreshToken (null)', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockResolvedValue({
            id: 2,
            role: 'EMPLOYEE',
            email: 'test@finnegans.com.ar',
            googleId: '456',
            fullName: 'Test',
            refreshToken: null
        });

        await upsertGoogleUser({
            email: 'test@finnegans.com.ar',
            googleId: '456',
            fullName: 'Test'
            // Sin refreshToken
        }, undefined);

        const callArgs = prisma.user.upsert.mock.calls[0][0];

        expect(callArgs.create.refreshToken).toBeNull();
    });

    test('Debe actualizar refreshToken encriptado en usuario existente', async () => {
        asignarRol.mockReturnValue('EMPLOYEE');
        prisma.user.upsert.mockResolvedValue({
            id: 1,
            role: 'EMPLOYEE',
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan',
            refreshToken: 'new_encrypted_token'
        });

        const newRefreshToken = 'new_google_refresh_token_xyz789';

        await upsertGoogleUser({
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan',
            refreshToken: newRefreshToken
        }, undefined);

        const callArgs = prisma.user.upsert.mock.calls[0][0];

        // Verificar que el update también encripta
        expect(callArgs.update.refreshToken).toBeDefined();
        expect(callArgs.update.refreshToken).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
        expect(callArgs.update.refreshToken).not.toBe(newRefreshToken);
    });
});
