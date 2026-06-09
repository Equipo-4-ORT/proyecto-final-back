const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { requestLogger, errorHandler, authErrorHandler } = require('./shared/middleware');
const { authLimiter, apiLimiter } = require('./shared/middleware/rateLimiter');

const app = express();

// 1. Middlewares Globales
// CORS con credentials para que el browser mande/reciba las cookies de sesión.
// origin EXACTO (nunca '*'): el browser rechaza '*' junto con credentials:true.
app.use(
  cors({
    origin: process.env.FRONTEND_BASE_URL,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser()); // pobla req.cookies (lo lee authMiddleware) — antes de las rutas
app.use(requestLogger);

// 2. Rate limiting
app.use('/auth', authLimiter);
app.use('/api', apiLimiter); // cubre /api/users, /api/reports, etc. — no duplicar por sub-ruta

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/users.routes');
app.use('/auth', authRoutes);
app.use('/api/users', userRoutes);
const jiraRoutes = require('./modules/jira/jira.routes');
app.use('/api/jira', jiraRoutes);

const adminRoutes = require('./modules/admin/admin.routes');
app.use('/api/admin', adminRoutes);

const activitiesRoutes = require('./modules/activities/activities.routes');
app.use('/api/activities', activitiesRoutes);


const reportsRoutes = require('./modules/reports/reports.routes');
app.use('/api/reports', reportsRoutes);

const driveActivityRoutes = require('./modules/drive/drive-activity.routes');
app.use('/api/drive', driveActivityRoutes);

const calendarRoutes = require('./modules/calendar/calendar.routes');
app.use('/api/calendar', calendarRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

// 3. Error Handler (SIEMPRE al final)
app.use(authErrorHandler);
app.use(errorHandler);

// 4. Exportar (sin hacer listen)
module.exports = app;
