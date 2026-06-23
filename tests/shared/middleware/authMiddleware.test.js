// Archivo: tests/shared/middleware/authMiddleware.test.js
// El access token ahora viaja en una cookie HttpOnly (antes: header Authorization).

const jwt = require('jsonwebtoken');
const { authMiddleware } = require('../../../src/shared/middleware');
const logger = require('../../../src/shared/utils/logger');

jest.mock('jsonwebtoken');
jest.mock('../../../src/shared/utils/logger', () => ({
  error: jest.fn(),
}));
// requireValidGoogleToken (re-exportado por index.js) depende de prisma.
jest.mock('../../../src/shared/database/prisma', () => ({
  user: { findUnique: jest.fn() },
}));
jest.mock('../../../src/shared/utils/crypto', () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(),
}));

describe('Middleware: authMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { cookies: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();

    process.env.JWT_SECRET = 'super-secret-test-key';
    delete process.env.JWT_ACCESS_SECRET;

    jest.clearAllMocks();
  });

  test('1. Retorna 401 si no hay cookie access_token', () => {
    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'No autorizado' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('1b. Retorna 401 si req.cookies es undefined (sin cookie-parser)', () => {
    authMiddleware({}, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('2. Inyecta req.user y llama next() con un JWT válido en la cookie', () => {
    req.cookies.access_token = 'token-super-valido';
    const mockPayload = { sub: 'uuid-123', email: 'dev@test.com', role: 'ADMIN' };
    jwt.verify.mockReturnValue(mockPayload);

    authMiddleware(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('token-super-valido', process.env.JWT_SECRET);
    expect(req.user).toEqual({
      id: 'uuid-123',
      email: 'dev@test.com',
      role: 'ADMIN',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('2b. Usa JWT_ACCESS_SECRET si está definido (alias JWT_SECRET de respaldo)', () => {
    process.env.JWT_ACCESS_SECRET = 'access-secret';
    req.cookies.access_token = 'tok';
    jwt.verify.mockReturnValue({ sub: 'u', email: 'e', role: 'EMPLOYEE' });

    authMiddleware(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('tok', 'access-secret');
  });

  test('3. Retorna 401 específico si el token expiró', () => {
    req.cookies.access_token = 'token-viejito';
    const expiredError = new Error('jwt expired');
    expiredError.name = 'TokenExpiredError';
    jwt.verify.mockImplementation(() => {
      throw expiredError;
    });

    authMiddleware(req, res, next);

    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token expirado' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('4. Retorna 401 genérico si el token es inválido', () => {
    req.cookies.access_token = 'token-falso-o-modificado';
    jwt.verify.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    authMiddleware(req, res, next);

    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token inválido' }));
    expect(next).not.toHaveBeenCalled();
  });
});
