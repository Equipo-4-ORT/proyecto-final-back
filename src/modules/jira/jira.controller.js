/**
 * Controller del módulo Jira: adapta req/res ↔ service. Sin lógica de negocio.
 *
 * Todos los endpoints autenticados toman el `userId` de `req.user.id` (lo setea
 * el middleware de auth interno — F1-05). Hasta que ese middleware exista, si no
 * hay `req.user` respondemos 401.
 */

const service = require('./jira.service');
const { config } = require('./jira.constants');

const MAX_CALLBACK_PARAM_LENGTH = 2048;

const requireUserId = (req) => {
    const userId = req.user && req.user.id;
    if (!userId) {
        const error = new Error('No autenticado');
        error.status = 401;
        error.code = 'unauthenticated';
        throw error;
    }
    return userId;
};

const buildFrontendRedirect = (params) => {
    const url = new URL('/profile', config.frontendBaseUrl);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
};

/** GET /api/jira/auth */
const getAuthUrl = async (req, res, next) => {
    try {
        const userId = requireUserId(req);
        const result = await service.initiateConnection(userId);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

/** GET /api/jira/auth/callback — sin middleware de auth; la autorización va por el `state`. */
const handleCallback = async (req, res, next) => {
    try {
        const pick = (value) =>
            typeof value === 'string' && value.length <= MAX_CALLBACK_PARAM_LENGTH ? value : undefined;
        const result = await service.handleCallback({
            code: pick(req.query.code),
            state: pick(req.query.state),
            error: pick(req.query.error),
        });

        if (result.outcome === 'connected') {
            return res.redirect(302, buildFrontendRedirect({ jira: 'connected' }));
        }
        if (result.outcome === 'cancelled') {
            return res.redirect(302, buildFrontendRedirect({ jira: 'cancelled' }));
        }
        return res.redirect(302, buildFrontendRedirect({ jira: 'error', reason: result.reason }));
    } catch (error) {
        next(error);
    }
};

/** GET /api/jira/status */
const getStatus = async (req, res, next) => {
    try {
        const userId = requireUserId(req);
        const status = await service.getStatus(userId);
        res.status(200).json(status);
    } catch (error) {
        next(error);
    }
};

/** DELETE /api/jira/connection */
const disconnect = async (req, res, next) => {
    try {
        const userId = requireUserId(req);
        await service.disconnect(userId, { source: 'self' });
        res.status(204).send();
    } catch (error) {
        next(error);
    }
};

/** POST /api/jira/sync */
const triggerSync = async (req, res, next) => {
    try {
        const userId = requireUserId(req);
        const { dateStart, dateEnd } = req.body || {};
        const result = await service.syncForUser(userId, dateStart, dateEnd);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getAuthUrl,
    handleCallback,
    getStatus,
    disconnect,
    triggerSync,
};
