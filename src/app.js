const express = require('express');
const cors = require('cors');
const { requestLogger, errorHandler, authErrorHandler } = require('./shared/middleware');
const { authLimiter, apiLimiter } = require('./shared/middleware/rateLimiter');

const app = express();

// 1. Middlewares Globales
// TODO: restringir orígenes antes de ir a prod. Ver https://expressjs.com/en/resources/middleware/cors.html
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// 2. Rate limiting
app.use('/auth', authLimiter);
app.use('/api', apiLimiter);

const authRoutes = require('./modules/auth/auth.routes');
app.use('/auth', authRoutes);

const adminRoutes = require('./modules/admin/admin.routes');
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// 3. Error Handler (SIEMPRE al final)
app.use(authErrorHandler);
app.use(errorHandler);

// 4. Exportar (sin hacer listen)
module.exports = app;
