const express = require('express');
const cors = require('cors');
const { requestLogger, errorHandler } = require('./shared/middleware');

const app = express();

// 1. Middlewares Globales
// TODO: restringir orígenes antes de ir a prod. Ver https://expressjs.com/en/resources/middleware/cors.html
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// 2. Rutas Base (las irán agregando a medida que hagan los módulos)
// const authRoutes = require('./modules/auth/auth.routes');
// app.use('/api/auth', authRoutes);
const jiraRoutes = require('./modules/jira/jira.routes');
app.use('/api/jira', jiraRoutes);

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
    });
});

// 3. Error Handler (SIEMPRE al final)
app.use(errorHandler);

// 4. Exportar (sin hacer listen)
module.exports = app;
