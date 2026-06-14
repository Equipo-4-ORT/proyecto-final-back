/**
 * Servicio del módulo Jira: orquesta client + mapper + Prisma.
 *
 * - `initiateConnection` / `handleCallback`: flujo OAuth 3LO.
 * - `getStatus`: estado de la conexión del usuario.
 * - `disconnect`: limpia credenciales (idempotente; reusable desde el CRUD de usuarios — RN-14).
 * - `syncForUser(userId, dateStart, dateEnd)`: importa la actividad Jira de la ventana.
 *   Agnóstico del caller — puede invocarlo un cron, un endpoint o un script de recovery.
 */

const crypto = require('crypto');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { encrypt, decrypt } = require('../../shared/utils/crypto');
const client = require('./jira.client');
const mapper = require('./jira.mapper');
const {
    config,
    OAUTH_STATE_TTL_MS,
    OAUTH_STATE_BYTES,
    CLOUD_ID_REGEX,
} = require('./jira.constants');
const {
    JiraUserNotFoundError,
    JiraNotConnectedError,
    JiraReconnectRequiredError,
    JiraInvalidWindowError,
} = require('./jira.errors');

const findUserOrThrow = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        throw new JiraUserNotFoundError();
    }
    return user;
};

// ———————————————————————— Conexión (OAuth 3LO) ————————————————————————

/**
 * Inicia el flujo OAuth: valida que el user exista, genera y persiste un `state`
 * one-shot con TTL, y devuelve la URL de autorización para que el frontend redirija.
 * @returns {Promise<{authorizationUrl: string}>}
 */
const initiateConnection = async (userId) => {
    await findUserOrThrow(userId);

    const state = crypto.randomBytes(OAUTH_STATE_BYTES).toString('hex');
    await prisma.jiraOAuthState.create({
        data: {
            state,
            userId,
            expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
        },
    });

    logger.info('jira.connection.initiated', { userId });
    return { authorizationUrl: client.buildAuthorizationUrl(state) };
};

/**
 * Procesa el callback de Atlassian. Nunca lanza: devuelve un resultado tipado para
 * que el controller arme el redirect al frontend.
 * @returns {Promise<{outcome: 'connected'|'cancelled'|'error', reason?: string}>}
 */
const handleCallback = async ({ code, state, error } = {}) => {
    if (error === 'access_denied') {
        logger.info('jira.callback.user_cancelled', { state: typeof state === 'string' ? state.slice(0, 8) : null });
        return { outcome: 'cancelled' };
    }
    if (error) {
        logger.warn('jira.callback.upstream_error', { error });
        return { outcome: 'error', reason: 'token_exchange_failed' };
    }
    if (typeof state !== 'string' || !state || typeof code !== 'string' || !code) {
        logger.warn('jira.callback.invalid_state', { state: typeof state === 'string' ? state.slice(0, 8) : null });
        return { outcome: 'error', reason: 'invalid_state' };
    }

    const stored = await prisma.jiraOAuthState.findUnique({ where: { state } });
    if (!stored || stored.expiresAt.getTime() < Date.now()) {
        if (stored) {
            await prisma.jiraOAuthState.delete({ where: { state } }).catch(() => {});
        }
        logger.warn('jira.callback.invalid_state', { state: state.slice(0, 8) });
        return { outcome: 'error', reason: 'invalid_state' };
    }
    // one-shot: consumir el state
    await prisma.jiraOAuthState.delete({ where: { state } }).catch(() => {});

    const userId = stored.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        logger.warn('jira.callback.user_not_found', { userId });
        return { outcome: 'error', reason: 'user_not_found' };
    }

    let tokens;
    try {
        tokens = await client.exchangeCodeForTokens(code);
    } catch (err) {
        logger.error('jira.token_exchange.failed', { userId, status: err.status });
        return { outcome: 'error', reason: 'token_exchange_failed' };
    }

    let resources;
    try {
        resources = await client.getAccessibleResources(tokens.accessToken);
    } catch (err) {
        logger.error('jira.token_exchange.failed', { userId, status: err.status, stage: 'accessible-resources' });
        return { outcome: 'error', reason: 'token_exchange_failed' };
    }
    const site = Array.isArray(resources) ? resources.find((r) => r && CLOUD_ID_REGEX.test(String(r.id || ''))) : null;
    if (!site) {
        logger.warn('jira.callback.no_jira_site', { userId });
        return { outcome: 'error', reason: 'no_jira_site' };
    }

    try {
        await prisma.user.update({
            where: { id: userId },
            data: {
                jiraRefreshToken: encrypt(tokens.refreshToken),
                jiraCloudId: site.id,
                jiraSiteUrl: site.url || null,
                jiraConnectedAt: new Date(),
                jiraReconnectRequired: false,
            },
        });
    } catch (err) {
        logger.error('jira.persistence.failed', { userId, operation: 'connect', error: err.message });
        return { outcome: 'error', reason: 'persistence_failed' };
    }

    logger.info('jira.connection.completed', { userId, cloudId: site.id, siteUrl: site.url });
    return { outcome: 'connected' };
};

// ———————————————————————— Estado / desconexión ————————————————————————

/**
 * @returns {Promise<{connected: boolean, siteUrl: string|null, lastSyncAt: Date|null, reconnectRequired: boolean}>}
 */
const getStatus = async (userId) => {
    const user = await findUserOrThrow(userId);
    const connected = Boolean(user.jiraRefreshToken && user.jiraCloudId);
    return {
        connected,
        siteUrl: connected ? user.jiraSiteUrl ?? null : null,
        lastSyncAt: connected ? user.jiraLastSyncAt ?? null : null,
        reconnectRequired: connected ? Boolean(user.jiraReconnectRequired) : false,
    };
};

/**
 * Desconecta la cuenta de Jira del usuario. **Idempotente**: si el user no existe
 * o no estaba conectado, no lanza — para que el CRUD de usuarios (RN-14) pueda
 * invocarlo sin chequear estado previo.
 * @param {string} userId
 * @param {{source?: 'self'|'admin_delete'}} [opts]
 */
const disconnect = async (userId, { source = 'self' } = {}) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        return; // idempotente
    }

    if (user.jiraRefreshToken) {
        let plainRefresh = null;
        try {
            plainRefresh = decrypt(user.jiraRefreshToken);
        } catch (err) {
            logger.warn('jira.disconnect.decrypt_failed', { userId, error: err.message });
        }
        if (plainRefresh) {
            await client.revokeRefreshToken(plainRefresh); // best effort, no lanza
        }
    }

    await prisma.user.update({
        where: { id: userId },
        data: {
            jiraRefreshToken: null,
            jiraCloudId: null,
            jiraSiteUrl: null,
            jiraConnectedAt: null,
            jiraReconnectRequired: false,
        },
    });

    logger.info('jira.connection.disconnected', { userId, source });
};

// ———————————————————————————— Sync ————————————————————————————

const HOUR_MS = 60 * 60 * 1000;

const parseWindowOrThrow = (dateStart, dateEnd) => {
    const start = new Date(dateStart);
    const end = new Date(dateEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new JiraInvalidWindowError('dateStart y dateEnd deben ser fechas ISO 8601 válidas');
    }
    if (start.getTime() >= end.getTime()) {
        throw new JiraInvalidWindowError('dateStart debe ser anterior a dateEnd');
    }
    if (end.getTime() - start.getTime() > config.syncMaxWindowHours * HOUR_MS) {
        throw new JiraInvalidWindowError(`La ventana no puede superar las ${config.syncMaxWindowHours} horas`);
    }
    return { start, end };
};

const markReconnectRequired = async (userId) => {
    await prisma.user.update({ where: { id: userId }, data: { jiraReconnectRequired: true } }).catch(() => {});
};

/**
 * Sincroniza la actividad Jira del usuario dentro de `[dateStart, dateEnd)`.
 *
 * @param {string} userId
 * @param {string|Date} dateStart - ISO 8601 con timezone.
 * @param {string|Date} dateEnd   - ISO 8601 con timezone.
 * @returns {Promise<{imported: number, skippedDuplicates: number, durationMs: number}>}
 * @throws {JiraInvalidWindowError|JiraUserNotFoundError|JiraNotConnectedError|JiraReconnectRequiredError|JiraTimeoutError|JiraUpstreamError}
 */
const syncForUser = async (userId, dateStart, dateEnd) => {
    const startedAt = Date.now();
    const { start, end } = parseWindowOrThrow(dateStart, dateEnd);

    const user = await findUserOrThrow(userId);
    if (!user.jiraRefreshToken || !user.jiraCloudId) {
        throw new JiraNotConnectedError();
    }
    if (user.jiraReconnectRequired) {
        throw new JiraReconnectRequiredError();
    }

    const cloudId = user.jiraCloudId;
    const plainRefresh = decrypt(user.jiraRefreshToken);

    // 1. Refrescar access token (rotation: viene un refresh nuevo).
    let refreshed;
    try {
        refreshed = await client.refreshAccessToken(plainRefresh);
    } catch (err) {
        if (err instanceof JiraReconnectRequiredError) {
            logger.warn('jira.refresh.invalid_grant', { userId });
            await markReconnectRequired(userId);
        }
        throw err;
    }

    // 2. Persistir el nuevo refresh ANTES de usar el access (si falla, el viejo sigue válido).
    await prisma.user.update({
        where: { id: userId },
        data: { jiraRefreshToken: encrypt(refreshed.refreshToken) },
    });
    const accessToken = refreshed.accessToken;

    // 3. Recolectar actividad.
    let activities = [];
    try {
        const me = await client.getMyself(cloudId, accessToken);
        const myAccountId = me.accountId;
        const issues = await client.searchIssuesUpdatedInRange(cloudId, accessToken, start, end);

        for (const issue of issues) {
            const [histories, comments, worklogs] = await Promise.all([
                client.getChangelog(cloudId, accessToken, issue.key),
                client.getComments(cloudId, accessToken, issue.key),
                client.getWorklogs(cloudId, accessToken, issue.key),
            ]);
            activities = activities.concat(
                mapper.issueToActivities({ userId, issue, histories, comments, worklogs, myAccountId, defaultDuration: user.defaultDuration }, start, end),
            );
        }
    } catch (err) {
        if (err instanceof JiraReconnectRequiredError) {
            logger.warn('jira.sync.reconnect_required', { userId });
            await markReconnectRequired(userId);
        }
        throw err;
    }

    // 4. Persistir (idempotente vía unique (userId, source, externalId)).
    let imported = 0;
    if (activities.length > 0) {
        const result = await prisma.dailyActivity.createMany({ data: activities, skipDuplicates: true });
        imported = result.count;
    }
    const skippedDuplicates = activities.length - imported;

    await prisma.user.update({ where: { id: userId }, data: { jiraLastSyncAt: new Date() } });

    const durationMs = Date.now() - startedAt;
    logger.info('jira.sync.completed', {
        userId,
        dateStart: start.toISOString(),
        dateEnd: end.toISOString(),
        imported,
        skippedDuplicates,
        durationMs,
    });
    return { imported, skippedDuplicates, durationMs };
};

module.exports = {
    initiateConnection,
    handleCallback,
    getStatus,
    disconnect,
    syncForUser,
};
