jest.mock('../../../src/modules/admin/admin.service', () => {
    class UserAlreadyExistsError extends Error {
        constructor(email) { super(`El email ${email} ya está registrado`); this.name = 'UserAlreadyExistsError'; this.statusCode = 409; }
    }
    class UserNotFoundError extends Error {
        constructor(id) { super(`Usuario ${id} no encontrado`); this.name = 'UserNotFoundError'; this.statusCode = 404; }
    }
    return {
        createUser: jest.fn(),
        listUsers: jest.fn(),
        toggleUserStatus: jest.fn(),
        UserAlreadyExistsError,
        UserNotFoundError,
    };
});
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
}));

const { postUser, getUsers, patchUserStatus } = require('../../../src/modules/admin/admin.controller');
const { createUser, listUsers, toggleUserStatus, UserAlreadyExistsError, UserNotFoundError } =
    require('../../../src/modules/admin/admin.service');

const MOCK_USER = { id: 'uuid-1', fullName: 'Ana García', email: 'ana@empresa.com', role: 'EMPLOYEE', status: 'ACTIVE' };

let req, res;
beforeEach(() => {
    jest.clearAllMocks();
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    req = { body: {}, params: {} };
});

describe('postUser', () => {
    test('responde 400 si falta algún campo requerido', async () => {
        req.body = { email: 'ana@empresa.com', role: 'EMPLOYEE' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    test('responde 400 si el role no es válido', async () => {
        req.body = { fullName: 'Ana', email: 'ana@empresa.com', role: 'SUPERADMIN' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('role') }));
    });

    test('responde 400 si el email no tiene formato válido', async () => {
        req.body = { fullName: 'Ana', email: 'no-es-un-email', role: 'EMPLOYEE' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('email') }));
    });

    test('responde 201 con el usuario creado en el caso exitoso', async () => {
        req.body = { fullName: 'Ana García', email: 'ana@empresa.com', role: 'EMPLOYEE' };
        createUser.mockResolvedValue(MOCK_USER);

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(MOCK_USER);
    });

    test('responde 409 si el email ya está registrado', async () => {
        req.body = { fullName: 'Ana', email: 'ana@empresa.com', role: 'EMPLOYEE' };
        createUser.mockRejectedValue(new UserAlreadyExistsError('ana@empresa.com'));

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    test('responde 500 ante error inesperado', async () => {
        req.body = { fullName: 'Ana', email: 'ana@empresa.com', role: 'EMPLOYEE' };
        createUser.mockRejectedValue(new Error('DB caída'));

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('getUsers', () => {
    test('responde 200 con la lista de usuarios', async () => {
        listUsers.mockResolvedValue([MOCK_USER]);

        await getUsers(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith([MOCK_USER]);
    });

    test('responde 500 ante error inesperado', async () => {
        listUsers.mockRejectedValue(new Error('DB caída'));

        await getUsers(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('patchUserStatus', () => {
    test('responde 200 con el usuario actualizado', async () => {
        req.params.id = 'uuid-1';
        toggleUserStatus.mockResolvedValue({ ...MOCK_USER, status: 'INACTIVE' });

        await patchUserStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'INACTIVE' }));
    });

    test('responde 404 si el usuario no existe', async () => {
        req.params.id = 'id-inexistente';
        toggleUserStatus.mockRejectedValue(new UserNotFoundError('id-inexistente'));

        await patchUserStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    test('responde 500 ante error inesperado', async () => {
        req.params.id = 'uuid-1';
        toggleUserStatus.mockRejectedValue(new Error('DB caída'));

        await patchUserStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});
