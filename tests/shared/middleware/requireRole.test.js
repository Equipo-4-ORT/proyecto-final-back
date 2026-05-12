const requireRole = require('../../../src/shared/middleware/requireRole');

describe('Middleware requireRole', () => {
    test('Debería permitir acceso si el rol está en allowedRoles', () => {
        const middleware = requireRole('ADMIN', 'MANAGER');
        
        const req = { user: { role: 'ADMIN' } };
        const res = { 
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();
        
        middleware(req, res, next);
        
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('Debería retornar 403 si el rol NO está en allowedRoles', () => {
        const middleware = requireRole('ADMIN');
        
        const req = { user: { role: 'EMPLOYEE' } };
        const res = { 
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();
        
        middleware(req, res, next);
        
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: 'Forbidden',
                message: expect.stringContaining('ADMIN')
            })
        );
        expect(next).not.toHaveBeenCalled();
    });

    test('Debería aceptar múltiples roles', () => {
        const middleware = requireRole('ADMIN', 'MANAGER', 'SUPERVISOR');
        
        const req = { user: { role: 'SUPERVISOR' } };
        const res = { 
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();
        
        middleware(req, res, next);
        
        expect(next).toHaveBeenCalled();
    });

    test('Debería retornar 403 con mensaje de roles permitidos', () => {
        const middleware = requireRole('ADMIN', 'MANAGER');
        
        const req = { user: { role: 'EMPLOYEE' } };
        const res = { 
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();
        
        middleware(req, res, next);
        
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Acceso denegado. Se requiere uno de los roles: ADMIN, MANAGER'
            })
        );
    });
});