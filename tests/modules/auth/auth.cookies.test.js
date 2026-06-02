const {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  REFRESH_PATH,
} = require('../../../src/modules/auth/auth.cookies');

describe('auth.cookies', () => {
  let res;

  beforeEach(() => {
    res = { cookie: jest.fn(), clearCookie: jest.fn() };
    delete process.env.COOKIE_SECURE;
    delete process.env.COOKIE_SAMESITE;
    delete process.env.COOKIE_DOMAIN;
  });

  describe('setAccessCookie()', () => {
    test('setea access_token httpOnly, path / y maxAge 15min', () => {
      setAccessCookie(res, 'jwt-token');

      expect(res.cookie).toHaveBeenCalledWith(
        'access_token',
        'jwt-token',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          secure: false,
          path: '/',
          maxAge: 15 * 60 * 1000,
        }),
      );
    });
  });

  describe('setRefreshCookie()', () => {
    test('setea refresh_token httpOnly con path acotado a /auth/refresh', () => {
      setRefreshCookie(res, 'opaque-refresh');

      expect(REFRESH_PATH).toBe('/auth/refresh');
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'opaque-refresh',
        expect.objectContaining({
          httpOnly: true,
          path: '/auth/refresh',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }),
      );
    });
  });

  describe('flags por entorno', () => {
    test('secure=true con COOKIE_SECURE=true y sameSite configurable', () => {
      process.env.COOKIE_SECURE = 'true';
      process.env.COOKIE_SAMESITE = 'none';

      setAccessCookie(res, 't');

      expect(res.cookie).toHaveBeenCalledWith(
        'access_token',
        't',
        expect.objectContaining({ secure: true, sameSite: 'none' }),
      );
    });
  });

  describe('clearAuthCookies()', () => {
    test('limpia ambas cookies con sus paths originales', () => {
      clearAuthCookies(res);

      expect(res.clearCookie).toHaveBeenCalledWith(
        'access_token',
        expect.objectContaining({ path: '/' }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ path: '/auth/refresh' }),
      );
    });
  });
});
