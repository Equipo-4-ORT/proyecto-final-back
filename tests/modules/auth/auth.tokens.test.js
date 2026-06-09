const crypto = require('crypto');
const jwt = require('jsonwebtoken');

jest.mock('jsonwebtoken');

const {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiresAt,
  REFRESH_TTL_DAYS,
} = require('../../../src/modules/auth/auth.tokens');

describe('auth.tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = 'access-secret';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ACCESS_TTL;
  });

  describe('signAccessToken()', () => {
    test('firma con { sub, email, role } y el access secret', () => {
      jwt.sign.mockReturnValue('signed');

      const token = signAccessToken({ id: 'u1', email: 'a@b.com', role: 'ADMIN' });

      expect(token).toBe('signed');
      expect(jwt.sign).toHaveBeenCalledWith(
        { sub: 'u1', email: 'a@b.com', role: 'ADMIN' },
        'access-secret',
        { expiresIn: '15m' },
      );
    });

    test('usa JWT_SECRET como alias si JWT_ACCESS_SECRET falta', () => {
      delete process.env.JWT_ACCESS_SECRET;
      process.env.JWT_SECRET = 'legacy-secret';
      jwt.sign.mockReturnValue('x');

      signAccessToken({ id: 'u1', email: 'a@b.com', role: 'EMPLOYEE' });

      expect(jwt.sign).toHaveBeenCalledWith(expect.any(Object), 'legacy-secret', expect.any(Object));
    });

    test('respeta JWT_ACCESS_TTL', () => {
      process.env.JWT_ACCESS_TTL = '30s';
      jwt.sign.mockReturnValue('x');

      signAccessToken({ id: 'u', email: 'e', role: 'EMPLOYEE' });

      expect(jwt.sign).toHaveBeenCalledWith(expect.any(Object), expect.any(String), { expiresIn: '30s' });
    });
  });

  describe('verifyAccessToken()', () => {
    test('delega en jwt.verify con el secret', () => {
      jwt.verify.mockReturnValue({ sub: 'u1' });

      const decoded = verifyAccessToken('tok');

      expect(decoded).toEqual({ sub: 'u1' });
      expect(jwt.verify).toHaveBeenCalledWith('tok', 'access-secret');
    });
  });

  describe('generateRefreshToken()', () => {
    test('devuelve string base64url y distinto en cada llamada', () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();

      expect(typeof a).toBe('string');
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, sin +/=
      expect(a).not.toBe(b);
    });
  });

  describe('hashRefreshToken()', () => {
    test('SHA-256 hex (64 chars) y determinístico', () => {
      const h1 = hashRefreshToken('plano');
      const h2 = hashRefreshToken('plano');
      const expected = crypto.createHash('sha256').update('plano').digest('hex');

      expect(h1).toBe(expected);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    test('nunca devuelve el valor plano', () => {
      expect(hashRefreshToken('secreto')).not.toBe('secreto');
    });
  });

  describe('refreshExpiresAt()', () => {
    test('devuelve una fecha ~7 días en el futuro', () => {
      const now = Date.now();
      const exp = refreshExpiresAt().getTime();
      const days = (exp - now) / (24 * 60 * 60 * 1000);

      expect(Math.round(days)).toBe(REFRESH_TTL_DAYS);
    });
  });
});
