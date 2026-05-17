const authErrorHandler = require('../../../src/shared/middleware/authErrorHandler');

describe('Middleware: authErrorHandler', () => {
    let req, res, next;

    beforeEach(() => {
        req = {};
        res = {};
        next = jest.fn();
    });

    test('TokenExpiredError → status 401 y mensaje de token expirado', () => {
        const err = new Error();
        err.name = 'TokenExpiredError';

        authErrorHandler(err, req, res, next);

        expect(err.status).toBe(401);
        expect(err.message).toMatch(/expirado/i);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('JsonWebTokenError → status 401 y mensaje de token inválido', () => {
        const err = new Error();
        err.name = 'JsonWebTokenError';

        authErrorHandler(err, req, res, next);

        expect(err.status).toBe(401);
        expect(err.message).toMatch(/inválido/i);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('UnauthorizedError → status 401 y mensaje de no autorizado', () => {
        const err = new Error();
        err.name = 'UnauthorizedError';

        authErrorHandler(err, req, res, next);

        expect(err.status).toBe(401);
        expect(err.message).toMatch(/autorizado/i);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('Error con status 403 → lo propaga con status 403', () => {
        const err = new Error('Acceso denegado');
        err.status = 403;

        authErrorHandler(err, req, res, next);

        expect(err.status).toBe(403);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('ForbiddenError → status 403', () => {
        const err = new Error('Forbidden');
        err.name = 'ForbiddenError';

        authErrorHandler(err, req, res, next);

        expect(err.status).toBe(403);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('ForbiddenError sin mensaje usa mensaje por defecto', () => {
        const err = new Error();
        err.name = 'ForbiddenError';
        err.message = '';

        authErrorHandler(err, req, res, next);

        expect(err.message).toMatch(/denegado/i);
    });

    test('Error genérico desconocido → lo pasa a next sin modificar', () => {
        const err = new Error('Algo explotó');
        err.name = 'SomeOtherError';

        authErrorHandler(err, req, res, next);

        expect(err.status).toBeUndefined();
        expect(next).toHaveBeenCalledWith(err);
    });
});
