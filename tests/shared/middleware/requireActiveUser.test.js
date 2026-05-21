jest.mock('../../../src/shared/database/prisma', () => ({
    user: { findUnique: jest.fn() },
}));
jest.mock('../../../src/shared/utils/logger', () => ({
    warn: jest.fn(),
    error: jest.fn(),
}));

const requireActiveUser = require('../../../src/shared/middleware/requireActiveUser');
const prisma = require('../../../src/shared/database/prisma');

describe('Middleware requireActiveUser', () => {
    let req, res, next;

    beforeEach(() => {
        jest.clearAllMocks();
        req = { user: { id: 'uuid-1', email: 'admin@empresa.com', role: 'ADMIN' } };
        res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        next = jest.fn();
    });

    test('responde 401 si no hay usuario autenticado en req', async () => {
        req.user = undefined;

        await requireActiveUser(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('responde 401 si el usuario del token ya no existe en la BD', async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await requireActiveUser(req, res, next);

        expect(prisma.user.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'uuid-1' } })
        );
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('responde 403 si el usuario existe pero no está activo', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'uuid-1', role: 'ADMIN', status: 'INACTIVE' });

        await requireActiveUser(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('llama a next y refresca req.user con los datos de la BD si está activo', async () => {
        const dbUser = {
            id: 'uuid-1',
            email: 'admin@empresa.com',
            fullName: 'Admin',
            role: 'ADMIN',
            status: 'ACTIVE',
        };
        prisma.user.findUnique.mockResolvedValue(dbUser);

        await requireActiveUser(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual(dbUser);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('usa el role vigente de la BD aunque el token tenga otro', async () => {
        // El token decía ADMIN, pero en la BD el usuario fue degradado a EMPLOYEE.
        req.user = { id: 'uuid-1', role: 'ADMIN' };
        prisma.user.findUnique.mockResolvedValue({ id: 'uuid-1', role: 'EMPLOYEE', status: 'ACTIVE' });

        await requireActiveUser(req, res, next);

        expect(req.user.role).toBe('EMPLOYEE');
        expect(next).toHaveBeenCalled();
    });

    test('responde 500 si la consulta a la BD falla', async () => {
        prisma.user.findUnique.mockRejectedValue(new Error('DB caída'));

        await requireActiveUser(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(next).not.toHaveBeenCalled();
    });
});
