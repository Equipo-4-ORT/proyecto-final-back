// Archivo: tests/shared/middleware/authMiddleware.test.js

const jwt = require('jsonwebtoken');
const { authMiddleware } = require('../../../src/shared/middleware');
const logger = require('../../../src/shared/utils/logger');

// Mockeamos dependencias externas para aislar el test
jest.mock('jsonwebtoken');
jest.mock('../../../src/shared/utils/logger', () => ({
  error: jest.fn(),
}));

describe('Middleware: authMiddleware', () => {
  let req, res, next;

  // Se ejecuta antes de cada test para reiniciar el estado
  beforeEach(() => {
    req = {
      headers: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();

    // Seteamos la variable de entorno necesaria
    process.env.JWT_SECRET = 'super-secret-test-key';

    // Limpiamos los mocks
    jest.clearAllMocks();
  });

  test('1. Debería retornar 401 si no hay header Authorization', () => {
    // Act
    authMiddleware(req, res, next);

    // Assert
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'No autorizado' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('2. Debería inyectar req.user y llamar a next() con un JWT válido', () => {
    // Arrange
    req.headers.authorization = 'Bearer token-super-valido';
    const mockPayload = { id: 'uuid-123', email: 'dev@test.com', role: 'ADMIN' };

    // Simulamos que jwt.verify funciona y devuelve nuestro payload
    jwt.verify.mockReturnValue(mockPayload);

    // Act
    authMiddleware(req, res, next);

    // Assert
    expect(jwt.verify).toHaveBeenCalledWith('token-super-valido', process.env.JWT_SECRET);
    expect(req.user).toEqual({
      id: 'uuid-123',
      email: 'dev@test.com',
      role: 'ADMIN',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('3. Debería retornar 401 específico si el token expiró', () => {
    // Arrange
    req.headers.authorization = 'Bearer token-viejito';
    const expiredError = new Error('jwt expired');
    expiredError.name = 'TokenExpiredError';

    // Simulamos que jwt.verify lanza el error de expiración
    jwt.verify.mockImplementation(() => {
      throw expiredError;
    });

    // Act
    authMiddleware(req, res, next);

    // Assert
    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token expirado' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('4. Debería retornar 401 genérico si el token es inválido', () => {
    // Arrange
    req.headers.authorization = 'Bearer token-falso-o-modificado';
    const invalidError = new Error('invalid signature');

    // Simulamos que jwt.verify lanza un error de firma
    jwt.verify.mockImplementation(() => {
      throw invalidError;
    });

    // Act
    authMiddleware(req, res, next);

    // Assert
    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token inválido' }));
    expect(next).not.toHaveBeenCalled();
  });
});
