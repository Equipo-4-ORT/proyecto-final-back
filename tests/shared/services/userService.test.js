const { upsertGoogleUser } = require('../../../src/shared/services/userService');
const prisma = require('../../../src/shared/database/prisma');

jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        upsert: jest.fn()
    }
}));

describe('Servicio de Usuarios (upsertGoogleUser)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Debe crear o actualizar el usuario usando el rol por defecto de Prisma', async () => {
        const mockGoogleData = {
            email: 'jperez@finnegans.com.ar',
            googleId: '123456789',
            fullName: 'Juan Pérez'
        };

        // Simulamos la respuesta de Prisma
        const mockDbResponse = { id: 1, ...mockGoogleData, role: 'EMPLOYEE' };
        prisma.user.upsert.mockResolvedValue(mockDbResponse);

        const result = await upsertGoogleUser(mockGoogleData);

        expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.user.upsert).toHaveBeenCalledWith({
            where: { email: 'jperez@finnegans.com.ar' },
            update: { googleId: '123456789', fullName: 'Juan Pérez' },
            create: {
                email: 'jperez@finnegans.com.ar',
                googleId: '123456789',
                fullName: 'Juan Pérez'
                // Ya no pasamos el rol, dejamos que Prisma asigne el default
            }
        });
        expect(result).toEqual(mockDbResponse);
    });

    test('Debe lanzar un error controlado si la base de datos falla', async () => {
        const mockGoogleData = { email: 'error@test.com', googleId: '000', fullName: 'Error' };

        prisma.user.upsert.mockRejectedValue(new Error('Conexión perdida con PostgreSQL'));

        await expect(upsertGoogleUser(mockGoogleData)).rejects.toThrow('No se pudo guardar el usuario en la base de datos');
    });
});