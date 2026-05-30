jest.mock('../../../src/modules/calendar/calendar.service', () => ({
  persistCalendarActivities: jest.fn(),
}));
jest.mock('../../../src/shared/utils/refreshToken', () => ({
  getDecryptedRefreshToken: jest.fn(),
}));
jest.mock('../../../src/shared/utils/logger', () => ({
  error: jest.fn(),
}));

const { syncCalendar } = require('../../../src/modules/calendar/calendar.controller');
const { persistCalendarActivities } = require('../../../src/modules/calendar/calendar.service');
const { getDecryptedRefreshToken } = require('../../../src/shared/utils/refreshToken');

let req, res;
beforeEach(() => {
  jest.clearAllMocks();
  res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  req = { user: { id: 'user-1' }, body: {} };
});

describe('syncCalendar', () => {
  test('responde 400 si no se envía date', async () => {
    req.body = {};

    await syncCalendar(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getDecryptedRefreshToken).not.toHaveBeenCalled();
  });

  test('responde 400 si date tiene formato inválido', async () => {
    req.body = { date: '26-05-2026' };

    await syncCalendar(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('YYYY-MM-DD') }),
    );
    expect(getDecryptedRefreshToken).not.toHaveBeenCalled();
  });

  test('responde 400 si date tiene shape válido pero no es una fecha real', async () => {
    req.body = { date: '2026-13-40' };

    await syncCalendar(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(persistCalendarActivities).not.toHaveBeenCalled();
  });

  test('responde 400 si el usuario no tiene refresh token', async () => {
    req.body = { date: '2026-05-26' };
    getDecryptedRefreshToken.mockResolvedValue(null);

    await syncCalendar(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(persistCalendarActivities).not.toHaveBeenCalled();
  });

  test('responde 200 con el resultado del service', async () => {
    req.body = { date: '2026-05-26' };
    getDecryptedRefreshToken.mockResolvedValue('decrypted-token');
    persistCalendarActivities.mockResolvedValue({
      count: 2,
      message: '2 actividades de calendario guardadas',
    });

    await syncCalendar(req, res);

    expect(getDecryptedRefreshToken).toHaveBeenCalledWith('user-1');
    expect(persistCalendarActivities).toHaveBeenCalledWith('user-1', 'decrypted-token', '2026-05-26');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      count: 2,
      message: '2 actividades de calendario guardadas',
    });
  });

  test('responde 500 si el service lanza un error', async () => {
    req.body = { date: '2026-05-26' };
    getDecryptedRefreshToken.mockResolvedValue('decrypted-token');
    persistCalendarActivities.mockRejectedValue(new Error('boom'));

    await syncCalendar(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
