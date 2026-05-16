const express = require('express');
const request = require('supertest');
const { createAuthLimiter, createApiLimiter } = require('../../../src/shared/middleware/rateLimiter');

const buildApp = (limiter, path = '/test') => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(path, limiter);
    app.get(path, (req, res) => res.status(200).json({ ok: true }));
    return app;
};

describe('Middleware: rateLimiter', () => {
    test('authLimiter permite requests dentro del límite', async () => {
        const app = buildApp(createAuthLimiter({ max: 3 }));

        await request(app).get('/test').expect(200);
        await request(app).get('/test').expect(200);
    });

    test('authLimiter bloquea con 429 al superar el límite', async () => {
        const app = buildApp(createAuthLimiter({ max: 2 }));

        await request(app).get('/test').expect(200);
        await request(app).get('/test').expect(200);
        const res = await request(app).get('/test').expect(429);

        expect(res.body).toHaveProperty('error');
        expect(res.body.error).toMatch(/intentos/i);
    });

    test('apiLimiter permite requests dentro del límite', async () => {
        const app = buildApp(createApiLimiter({ max: 3 }), '/api/test');

        await request(app).get('/api/test').expect(200);
        await request(app).get('/api/test').expect(200);
    });

    test('apiLimiter bloquea con 429 al superar el límite', async () => {
        const app = buildApp(createApiLimiter({ max: 2 }), '/api/test');

        await request(app).get('/api/test').expect(200);
        await request(app).get('/api/test').expect(200);
        const res = await request(app).get('/api/test').expect(429);

        expect(res.body).toHaveProperty('error');
        expect(res.body.error).toMatch(/límite/i);
    });

    test('authLimiter y apiLimiter son instancias independientes', async () => {
        const authApp = buildApp(createAuthLimiter({ max: 1 }), '/auth');
        const apiApp = buildApp(createApiLimiter({ max: 1 }), '/api');

        // Agotar el límite de auth no afecta el de api
        await request(authApp).get('/auth').expect(200);
        await request(authApp).get('/auth').expect(429);
        await request(apiApp).get('/api').expect(200);
    });

    test('La respuesta 429 incluye headers de rate limit', async () => {
        const app = buildApp(createAuthLimiter({ max: 1 }));

        await request(app).get('/test').expect(200);
        const res = await request(app).get('/test').expect(429);

        const hasRateLimitHeader =
            'ratelimit-limit' in res.headers ||
            'x-ratelimit-limit' in res.headers;
        expect(hasRateLimitHeader).toBe(true);
    });
});
