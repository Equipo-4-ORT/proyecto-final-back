/**
 * Helpers para setear/limpiar las cookies de sesión.
 *
 * Flags de seguridad:
 * - httpOnly: el JS del browser NO puede leer la cookie → mitiga robo por XSS.
 * - secure: solo viaja por HTTPS (true en prod; false en localhost).
 * - sameSite=lax: el browser no adjunta la cookie en POST/PUT/DELETE cross-site → mitiga CSRF.
 * - el refresh va con path=/auth/refresh para que SOLO se mande a ese endpoint.
 *
 * Las opciones se calculan en cada llamada para leer las env vars vigentes
 * (config por entorno + testabilidad). clearCookie usa las MISMAS opciones que
 * el cookie original (path/domain/sameSite/secure), si no el browser no la borra.
 */
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // 15 min
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const REFRESH_PATH = '/auth/refresh';

const baseCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  domain: process.env.COOKIE_DOMAIN || undefined, // vacío → el browser usa el host actual
});

const setAccessCookie = (res, token) => {
  res.cookie('access_token', token, {
    ...baseCookieOptions(),
    path: '/',
    maxAge: ACCESS_MAX_AGE_MS,
  });
};

const setRefreshCookie = (res, token) => {
  res.cookie('refresh_token', token, {
    ...baseCookieOptions(),
    path: REFRESH_PATH,
    maxAge: REFRESH_MAX_AGE_MS,
  });
};

const clearAuthCookies = (res) => {
  res.clearCookie('access_token', { ...baseCookieOptions(), path: '/' });
  res.clearCookie('refresh_token', { ...baseCookieOptions(), path: REFRESH_PATH });
};

module.exports = {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  REFRESH_PATH,
};
