const nodeCrypto = require('crypto');

// La key DEBE setearse ANTES del require de users.service
process.env.ENCRYPTION_KEY = nodeCrypto.randomBytes(32).toString('hex');

const { upsertGoogleUser } = require('../../../src/modules/users/users.service');
const prisma = require('../../../src/shared/database/prisma');
const { encrypt } = require('../../../src/shared/utils/crypto');

jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        upsert: jest.fn(),
        count: jest.fn()
    }
}));

jest.mock('../../../src/shared/utils/crypto');

describe('Servicio de Usuarios (upsertGoogleUser)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Primer usuario debe ser asignado como ADMIN', async () => {
        prisma.user.count.mockResolvedValue(0); // BD vacía
        prisma.user.upsert.mockResolvedValue({ id: 1, role: 'ADMIN', email: 'jperez@finnegans.com.ar', googleId: '123', fullName: 'Juan' });

        await upsertGoogleUser({
            email: 'jperez@finnegans.com.ar',
            googleId: '123',
            fullName: 'Juan'
        });

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ role: 'ADMIN' })
            })
        );
    });

    test('Usuarios posteriores deben ser asignados como EMPLOYEE', async () => {
        prisma.user.count.mockResolvedValue(5); // BD con usuarios
        prisma.user.upsert.mockResolvedValue({ id: 2, role: 'EMPLOYEE', email: 'otro@finnegans.com.ar', googleId: '456', fullName: 'Otro' });

        await upsertGoogleUser({
            email: 'otro@finnegans.com.ar',
            googleId: '456',
            fullName: 'Otro'
        });

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ role: 'EMPLOYEE' })
            })
        );
    });

    test('Debe encriptar refreshToken si existe', async () => {
        prisma.user.count.mockResolvedValue(0);
        encrypt.mockReturnValue('encrypted_token_abc123');
        prisma.user.upsert.mockResolvedValue({ id: 1, role: 'ADMIN' });

        await upsertGoogleUser({
            email: 'test@finnegans.com.ar',
            googleId: '789',
            fullName: 'Test',
            refreshToken: 'raw_refresh_token'
        });

        expect(encrypt).toHaveBeenCalledWith('raw_refresh_token');
        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ refreshToken: 'encrypted_token_abc123' })
            })
        );
    });

    test('NO debe incluir refreshToken si no existe', async () => {
        prisma.user.count.mockResolvedValue(1);
        prisma.user.upsert.mockResolvedValue({ id: 2, role: 'EMPLOYEE' });

        await upsertGoogleUser({
            email: 'test@finnegans.com.ar',
            googleId: '789',
            fullName: 'Test'
        });

        expect(encrypt).not.toHaveBeenCalled();
        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.not.objectContaining({ refreshToken: expect.anything() })
            })
        );
    });

    test('Debe normalizar el email a lowercase y trim', async () => {
        prisma.user.count.mockResolvedValue(0);
        prisma.user.upsert.mockResolvedValue({});

        await upsertGoogleUser({
            email: '  JPerez@Finnegans.COM.ar  ',
            googleId: '123',
            fullName: 'Juan'
        });

        expect(prisma.user.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { email: 'jperez@finnegans.com.ar' },
                create: expect.objectContaining({ email: 'jperez@finnegans.com.ar' })
            })
        );
    });

    test('Debe lanzar error si email es undefined', async () => {
        await expect(upsertGoogleUser({ googleId: '123', fullName: 'Juan' }))
            .rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error si googleId es undefined', async () => {
        await expect(upsertGoogleUser({ email: 'a@a.com', fullName: 'Juan' }))
            .rejects.toThrow('email y googleId son requeridos');
    });

    test('Debe lanzar error controlado si la BD falla', async () => {
        prisma.user.count.mockResolvedValue(0);
        prisma.user.upsert.mockRejectedValue(new Error('Conexión perdida'));

        await expect(upsertGoogleUser({ email: 'error@test.com', googleId: '000', fullName: 'Error' }))
            .rejects.toThrow('No se pudo guardar el usuario en la base de datos');
    });
});