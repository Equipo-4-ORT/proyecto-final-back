const { upsertGoogleUser } = require('../../../src/modules/users/users.service');
const prisma = require('../../../src/shared/database/prisma');

jest.mock('../../../src/shared/database/prisma', () => ({
  user: {
    upsert: jest.fn(),
  },
}));

describe('Servicio de Usuarios (upsertGoogleUser)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Debe upsertear el usuario sin enviar role en el create (deja el default del schema)', async () => {
    const mockGoogleData = {
      email: 'jperez@finnegans.com.ar',
      googleId: '123456789',
      fullName: 'Juan Pérez',
    };
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
        fullName: 'Juan Pérez',
      },
    });
    expect(result).toEqual(mockDbResponse);
  });

  test('Debe normalizar el email a lowercase y trim antes de persistirlo', async () => {
    prisma.user.upsert.mockResolvedValue({});

    await upsertGoogleUser({
      email: '  JPerez@Finnegans.COM.ar  ',
      googleId: '123',
      fullName: 'Juan Pérez',
    });

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'jperez@finnegans.com.ar' },
        create: expect.objectContaining({ email: 'jperez@finnegans.com.ar' }),
      }),
    );
  });

  test('Debe lanzar error si email es undefined', async () => {
    await expect(upsertGoogleUser({ googleId: '123', fullName: 'Juan' })).rejects.toThrow(
      'email y googleId son requeridos',
    );
  });

  test('Debe lanzar error si googleId es undefined', async () => {
    await expect(upsertGoogleUser({ email: 'a@a.com', fullName: 'Juan' })).rejects.toThrow(
      'email y googleId son requeridos',
    );
  });

  test('Debe lanzar un error controlado si la base de datos falla', async () => {
    const mockGoogleData = { email: 'error@test.com', googleId: '000', fullName: 'Error' };
    prisma.user.upsert.mockRejectedValue(new Error('Conexión perdida con PostgreSQL'));

    await expect(upsertGoogleUser(mockGoogleData)).rejects.toThrow(
      'No se pudo guardar el usuario en la base de datos',
    );
  });
});
