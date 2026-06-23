/**
 * Tests de integración: guard EMPLOYEE en rutas del dashboard.
 *
 * Verifica que las rutas exclusivas de empleados (`/api/activities`,
 * `/api/drive`, `/api/calendar`, `/api/jira`) devuelvan 403 cuando el
 * usuario autenticado tiene rol ADMIN, y permitan el paso a EMPLOYEE.
 *
 * Estrategia: se mockea `authMiddleware` para inyectar `req.user` con el
 * rol deseado sin necesidad de un JWT real.  El resto de la cadena
 * (requireActiveUser → requireRole → handler) corre sobre el código real.
 */

process.env.FRONTEND_BASE_URL   = 'http://localhost:5173';
process.env.JWT_SECRET          = 'test-secret';
process.env.JIRA_CLIENT_ID      = 'test-jira-id';
process.env.JIRA_CLIENT_SECRET  = 'test-jira-secret';
process.env.JIRA_REDIRECT_URI   = 'http://localhost:3000/api/jira/auth/callback';
process.env.GOOGLE_CLIENT_ID    = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';

// ── Mocks de dependencias externas ───────────────────────────────────────────

// authMiddleware → sólo inyecta req.user (sin validar tokens)
jest.mock('../../src/shared/middleware/authMiddleware', () =>
  jest.fn((req, _res, next) => {
    // El rol se pasa via cabecera x-test-role en cada request de prueba
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 'user-test', email: 'u@test.com', role };
    next();
  })
);

// requireActiveUser → pass-through (no consulta la BD)
jest.mock('../../src/shared/middleware/requireActiveUser', () =>
  jest.fn((_req, _res, next) => next())
);

// requireValidGoogleToken → pass-through (no consulta Google)
jest.mock('../../src/shared/middleware/requireValidGoogleToken', () =>
  jest.fn((_req, _res, next) => next())
);

// Servicios: respuesta mínima para que los handlers no exploten
jest.mock('../../src/modules/activities/activities.service', () => ({
  listActivities: jest.fn().mockResolvedValue([]),
  createActivity: jest.fn().mockResolvedValue({}),
  updateActivity: jest.fn().mockResolvedValue({}),
  deleteActivity: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/modules/drive/drive-activity.service', () => ({
  persistDriveActivities: jest.fn().mockResolvedValue({ upserted: 0 }),
  getDriveActivitiesForDay: jest.fn().mockResolvedValue([]),
  summarizeDriveActivities: jest.fn().mockResolvedValue([]),
  enrichDriveActivitySummary: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/modules/calendar/calendar.service', () => ({
  syncCalendarActivities: jest.fn().mockResolvedValue({ synced: 0 }),
}));

// reports.sheet importa `googleapis` (que no carga en jest sin mock). Lo mockeamos
// para que `app.js` se pueda montar; estas pruebas no ejercitan rutas de reportes.
jest.mock('../../src/modules/reports/reports.sheet', () => ({
  createReportSheet: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/modules/jira/jira.service', () => ({
  initiateConnection: jest.fn().mockResolvedValue('http://jira-auth-url'),
  handleCallback:     jest.fn().mockResolvedValue({}),
  getStatus:          jest.fn().mockResolvedValue({ connected: false }),
  disconnect:         jest.fn().mockResolvedValue({}),
  syncForUser:        jest.fn().mockResolvedValue({ synced: 0 }),
}));

jest.mock('../../src/shared/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

const request = require('supertest');
const app     = require('../../src/app');

/**
 * Hace una request GET al `path` indicado inyectando `role` vía cabecera.
 */
function asRole(role) {
  return { get: (path) => request(app).get(path).set('x-test-role', role),
           post: (path) => request(app).post(path).set('x-test-role', role),
           delete: (path) => request(app).delete(path).set('x-test-role', role) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Guard EMPLOYEE en rutas del dashboard', () => {

  // ── /api/activities ────────────────────────────────────────────────────────
  describe('/api/activities', () => {
    test('EMPLOYEE puede GET /api/activities (200)', async () => {
      const res = await asRole('EMPLOYEE').get('/api/activities');
      expect(res.status).toBe(200);
    });

    test('ADMIN recibe 403 en GET /api/activities', async () => {
      const res = await asRole('ADMIN').get('/api/activities');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    test('EMPLOYEE puede POST /api/activities (no 403)', async () => {
      const res = await asRole('EMPLOYEE').post('/api/activities').send({});
      // El servicio puede rechazar con 400/422 por validación, pero NO con 403
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en POST /api/activities', async () => {
      const res = await asRole('ADMIN').post('/api/activities').send({});
      expect(res.status).toBe(403);
    });
  });

  // ── /api/drive ─────────────────────────────────────────────────────────────
  describe('/api/drive', () => {
    test('EMPLOYEE puede POST /api/drive/sync (no 403)', async () => {
      const res = await asRole('EMPLOYEE').post('/api/drive/sync').send({});
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en POST /api/drive/sync', async () => {
      const res = await asRole('ADMIN').post('/api/drive/sync').send({});
      expect(res.status).toBe(403);
    });
  });

  // ── /api/calendar ──────────────────────────────────────────────────────────
  describe('/api/calendar', () => {
    test('EMPLOYEE puede POST /api/calendar/sync (no 403)', async () => {
      const res = await asRole('EMPLOYEE').post('/api/calendar/sync').send({});
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en POST /api/calendar/sync', async () => {
      const res = await asRole('ADMIN').post('/api/calendar/sync').send({});
      expect(res.status).toBe(403);
    });
  });

  // ── /api/jira ──────────────────────────────────────────────────────────────
  describe('/api/jira', () => {
    test('EMPLOYEE puede GET /api/jira/auth (no 403)', async () => {
      const res = await asRole('EMPLOYEE').get('/api/jira/auth');
      // El servicio puede redirigir (302) o retornar 200 — nunca 403
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en GET /api/jira/auth', async () => {
      const res = await asRole('ADMIN').get('/api/jira/auth');
      expect(res.status).toBe(403);
    });

    test('EMPLOYEE puede GET /api/jira/status (no 403)', async () => {
      const res = await asRole('EMPLOYEE').get('/api/jira/status');
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en GET /api/jira/status', async () => {
      const res = await asRole('ADMIN').get('/api/jira/status');
      expect(res.status).toBe(403);
    });

    test('EMPLOYEE puede POST /api/jira/sync (no 403)', async () => {
      const res = await asRole('EMPLOYEE').post('/api/jira/sync').send({});
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en POST /api/jira/sync', async () => {
      const res = await asRole('ADMIN').post('/api/jira/sync').send({});
      expect(res.status).toBe(403);
    });

    test('EMPLOYEE puede DELETE /api/jira/connection (no 403)', async () => {
      const res = await asRole('EMPLOYEE').delete('/api/jira/connection');
      expect(res.status).not.toBe(403);
    });

    test('ADMIN recibe 403 en DELETE /api/jira/connection', async () => {
      const res = await asRole('ADMIN').delete('/api/jira/connection');
      expect(res.status).toBe(403);
    });

    // El callback OAuth es público — cualquier rol (o ninguno) puede acceder
    test('el callback /api/jira/auth/callback es público (no requiere rol)', async () => {
      const res = await request(app).get('/api/jira/auth/callback');
      // Sin x-test-role, si devuelve 403 fallaría el test
      expect(res.status).not.toBe(403);
    });
  });
});
