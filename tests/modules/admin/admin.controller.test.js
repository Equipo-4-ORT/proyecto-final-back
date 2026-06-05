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
        updateUser: jest.fn(),
        UserAlreadyExistsError,
        UserNotFoundError,
    };
});
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
}));
// El controller delega la asignación de role en el helper asignarRol de auth.service.
// Lo mockeamos para aislar el controller (asignarRol() sin llave => EMPLOYEE).
jest.mock('../../../src/modules/auth/auth.service', () => ({
    asignarRol: jest.fn(() => 'EMPLOYEE'),
}));

const { postUser, getUsers, patchUserStatus, editUser } = require('../../../src/modules/admin/admin.controller');
const { createUser, listUsers, toggleUserStatus, updateUser, UserAlreadyExistsError, UserNotFoundError } =
    require('../../../src/modules/admin/admin.service');
const { asignarRol } = require('../../../src/modules/auth/auth.service');

const MOCK_USER = { id: 'uuid-1', fullName: 'Ana García', email: 'ana@empresa.com', role: 'EMPLOYEE', status: 'ACTIVE' };

let req, res;
beforeEach(() => {
    jest.clearAllMocks();
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    req = { body: {}, params: {} };
});

describe('postUser', () => {
    test('responde 400 si falta fullName', async () => {
        req.body = { email: 'ana@empresa.com' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(createUser).not.toHaveBeenCalled();
    });

    test('responde 400 si falta email', async () => {
        req.body = { fullName: 'Ana García' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(createUser).not.toHaveBeenCalled();
    });

    test('responde 400 si el email no tiene formato válido', async () => {
        req.body = { fullName: 'Ana', email: 'no-es-un-email' };

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('email') }));
    });

    test('no exige role en el body: lo asigna el helper asignarRol (EMPLOYEE)', async () => {
        req.body = { fullName: 'Ana García', email: 'ana@empresa.com' };
        createUser.mockResolvedValue(MOCK_USER);

        await postUser(req, res);

        expect(asignarRol).toHaveBeenCalled();
        expect(createUser).toHaveBeenCalledWith(
            expect.objectContaining({ fullName: 'Ana García', email: 'ana@empresa.com', role: 'EMPLOYEE' })
        );
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(MOCK_USER);
    });

    test('ignora el role enviado por el cliente y usa el del helper', async () => {
        req.body = { fullName: 'Ana García', email: 'ana@empresa.com', role: 'ADMIN' };
        createUser.mockResolvedValue(MOCK_USER);

        await postUser(req, res);

        expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ role: 'EMPLOYEE' }));
        expect(createUser).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN' }));
        expect(res.status).toHaveBeenCalledWith(201);
    });

    test('responde 409 si el email ya está registrado', async () => {
        req.body = { fullName: 'Ana', email: 'ana@empresa.com' };
        createUser.mockRejectedValue(new UserAlreadyExistsError('ana@empresa.com'));

        await postUser(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    test('responde 500 ante error inesperado', async () => {
        req.body = { fullName: 'Ana', email: 'ana@empresa.com' };
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

describe('editUser', () => {
    test('responde 400 si el email tiene formato inválido', async () => {
        req.params.id = 'uuid-1';
        req.body = { email: 'no-es-un-email' };

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('email') }));
        expect(updateUser).not.toHaveBeenCalled();
    });

    test('responde 400 si el body viene vacío (ningún campo para actualizar)', async () => {
        req.params.id = 'uuid-1';
        req.body = {};

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(updateUser).not.toHaveBeenCalled();
    });

    test('responde 400 si fullName viene vacío o solo espacios', async () => {
        req.params.id = 'uuid-1';
        req.body = { fullName: '   ' };

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(updateUser).not.toHaveBeenCalled();
    });

    test('descarta el role enviado por el cliente y no lo pasa al service', async () => {
        req.params.id = 'uuid-1';
        req.body = { fullName: 'Ana García', role: 'ADMIN' };
        updateUser.mockResolvedValue(MOCK_USER);

        await editUser(req, res);

        expect(updateUser).toHaveBeenCalledWith('uuid-1', { fullName: 'Ana García' });
        expect(updateUser).not.toHaveBeenCalledWith('uuid-1', expect.objectContaining({ role: expect.anything() }));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('responde 200 con el usuario actualizado', async () => {
        req.params.id = 'uuid-1';
        req.body = { fullName: 'Ana Actualizada', email: 'nueva@empresa.com' };
        const updated = { ...MOCK_USER, fullName: 'Ana Actualizada', email: 'nueva@empresa.com' };
        updateUser.mockResolvedValue(updated);

        await editUser(req, res);

        expect(updateUser).toHaveBeenCalledWith('uuid-1', { fullName: 'Ana Actualizada', email: 'nueva@empresa.com' });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(updated);
    });

    test('responde 404 si el usuario no existe', async () => {
        req.params.id = 'id-inexistente';
        req.body = { fullName: 'Ana' };
        updateUser.mockRejectedValue(new UserNotFoundError('id-inexistente'));

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    test('responde 409 si el email ya pertenece a otro usuario', async () => {
        req.params.id = 'uuid-1';
        req.body = { email: 'ocupado@empresa.com' };
        updateUser.mockRejectedValue(new UserAlreadyExistsError('ocupado@empresa.com'));

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    test('responde 500 ante error inesperado', async () => {
        req.params.id = 'uuid-1';
        req.body = { fullName: 'Ana' };
        updateUser.mockRejectedValue(new Error('DB caída'));

        await editUser(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
    });
});
