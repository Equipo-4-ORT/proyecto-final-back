jest.mock('../../../src/shared/database/prisma', () => ({
    user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
    },
}));
jest.mock('../../../src/shared/utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
}));

const { createUser, listUsers, toggleUserStatus, UserAlreadyExistsError, UserNotFoundError } =
    require('../../../src/modules/admin/admin.service');
const prisma = require('../../../src/shared/database/prisma');

const MOCK_USER = {
    id: 'uuid-1',
    fullName: 'Ana García',
    email: 'ana@empresa.com',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01'),
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createUser', () => {
    test('lanza UserAlreadyExistsError si el email ya existe', async () => {
        prisma.user.findUnique.mockResolvedValue(MOCK_USER);

        await expect(createUser({ fullName: 'Ana', email: 'ana@empresa.com', role: 'EMPLOYEE' }))
            .rejects.toThrow(UserAlreadyExistsError);
    });

    test('crea el usuario con el email normalizado', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue(MOCK_USER);

        const result = await createUser({ fullName: 'Ana', email: '  ANA@Empresa.COM  ', role: 'EMPLOYEE' });

        expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'ana@empresa.com' } });
        expect(prisma.user.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ email: 'ana@empresa.com', status: 'ACTIVE' }),
            })
        );
        expect(result).toEqual(MOCK_USER);
    });
});

describe('listUsers', () => {
    test('devuelve la lista de usuarios ordenada por createdAt desc', async () => {
        prisma.user.findMany.mockResolvedValue([MOCK_USER]);

        const result = await listUsers();

        expect(result).toEqual([MOCK_USER]);
        expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { createdAt: 'desc' } })
        );
    });
});

describe('toggleUserStatus', () => {
    test('lanza UserNotFoundError si el usuario no existe', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(toggleUserStatus('id-inexistente')).rejects.toThrow(UserNotFoundError);
    });

    test('cambia el status de ACTIVE a INACTIVE', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, status: 'ACTIVE' });
        prisma.user.update.mockResolvedValue({ ...MOCK_USER, status: 'INACTIVE' });

        const result = await toggleUserStatus('uuid-1');

        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'INACTIVE' } })
        );
        expect(result.status).toBe('INACTIVE');
    });

    test('cambia el status de INACTIVE a ACTIVE', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, status: 'INACTIVE' });
        prisma.user.update.mockResolvedValue({ ...MOCK_USER, status: 'ACTIVE' });

        const result = await toggleUserStatus('uuid-1');

        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: 'ACTIVE' } })
        );
        expect(result.status).toBe('ACTIVE');
    });
});
