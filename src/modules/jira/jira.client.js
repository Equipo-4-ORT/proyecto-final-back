/**
 * Adapter HTTP contra Atlassian (OAuth 3LO + Jira REST API v3).
 *
 * Es el ÚNICO lugar del módulo con `fetch()`. El service llama a estos métodos;
 * los tests del service mockean este archivo entero.
 *
 * Usa `fetch` nativo de Node 20 (no agregamos `axios` por 4 endpoints).
 */

const logger = require('../../shared/utils/logger');
const {
    config,
    AUTHORIZE_URL,
    TOKEN_URL,
    TOKEN_REVOKE_URL,
    ACCESSIBLE_RESOURCES_URL,
    jiraApiBaseUrl,
    OAUTH_AUDIENCE,
    SEARCH_PAGE_SIZE,
} = require('./jira.constants');
const {
    JiraTimeoutError,
    JiraUpstreamError,
    JiraReconnectRequiredError,
    JiraTokenExchangeError,
} = require('./jira.errors');

// Backoffs (ms). Se exponen para poder acelerarlos en los tests.
const RETRY = {
    timeoutDelayMs: 1000,
    rateLimitDelayMs: 2000,
    serverErrorDelaysMs: [1000, 2000],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hace un fetch con timeout (AbortController) y reintentos:
 *  - timeout            → 1 retry (backoff 1s) → JiraTimeoutError
 *  - 429                → respeta Retry-After (o 2s) → 1 retry
 *  - 5xx                → 2 retries con backoff exponencial (1s, 2s) → JiraUpstreamError
 *  - 4xx (≠429)         → no reintenta; el caller decide (p.ej. 401 en refresh)
 *
 * @returns {Promise<Response>} la Response (ok o 4xx no-429); nunca un 5xx tras retries.
 */
const fetchWithRetry = async (url, options = {}, { label = 'atlassian' } = {}) => {
    let timeoutRetried = false;
    let rateLimitRetried = false;
    let serverErrorAttempt = 0;

    while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
        let response;
        try {
            response = await fetch(url, { ...options, signal: controller.signal });
        } catch (error) {
            clearTimeout(timer);
            const aborted = error.name === 'AbortError';
            if (aborted && !timeoutRetried) {
                timeoutRetried = true;
                logger.warn('jira.upstream.timeout', { endpoint: label, attempt: 1 });
                await sleep(RETRY.timeoutDelayMs);
                continue;
            }
            if (aborted) {
                logger.warn('jira.upstream.timeout', { endpoint: label, attempt: 2 });
                throw new JiraTimeoutError(`Timeout al llamar a ${label}`, { cause: error });
            }
            throw new JiraUpstreamError(`Error de red al llamar a ${label}`, { cause: error });
        }
        clearTimeout(timer);

        if (response.status === 429 && !rateLimitRetried) {
            rateLimitRetried = true;
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : RETRY.rateLimitDelayMs;
            logger.warn('jira.upstream.rate_limited', { endpoint: label, waitMs });
            await sleep(waitMs);
            continue;
        }

        if (response.status >= 500) {
            if (serverErrorAttempt < RETRY.serverErrorDelaysMs.length) {
                const delay = RETRY.serverErrorDelaysMs[serverErrorAttempt];
                serverErrorAttempt += 1;
                logger.error('jira.upstream.5xx', { endpoint: label, status: response.status, attempt: serverErrorAttempt });
                await sleep(delay);
                continue;
            }
            logger.error('jira.upstream.5xx', { endpoint: label, status: response.status, attempt: serverErrorAttempt + 1 });
            throw new JiraUpstreamError(`Atlassian respondió ${response.status} en ${label}`);
        }

        return response;
    }
};

const parseJsonSafe = async (response) => {
    try {
        return await response.json();
    } catch {
        return null;
    }
};

const formUrlEncoded = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            search.append(key, String(value));
        }
    }
    return search.toString();
};

// —————————————————————————— OAuth ——————————————————————————

/**
 * Construye (no llama) la URL de autorización 3LO. El frontend redirige a ella.
 * @param {string} state - token CSRF one-shot ya persistido.
 */
const buildAuthorizationUrl = (state) => {
    const params = new URLSearchParams({
        audience: OAUTH_AUDIENCE,
        client_id: config.clientId,
        scope: config.scopes,
        redirect_uri: config.redirectUri,
        state,
        response_type: 'code',
        prompt: 'consent',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
};

/**
 * Intercambia el `code` del callback por access + refresh tokens.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 */
const exchangeCodeForTokens = async (code) => {
    const response = await fetchWithRetry(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formUrlEncoded({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.redirectUri,
        }),
    }, { label: 'oauth/token (exchange)' });

    if (!response.ok) {
        logger.error('jira.token_exchange.failed', { status: response.status });
        throw new JiraTokenExchangeError(`Atlassian rechazó el intercambio del code (status ${response.status})`);
    }
    const data = await parseJsonSafe(response);
    if (!data || !data.access_token || !data.refresh_token) {
        throw new JiraTokenExchangeError('Respuesta de Atlassian sin access_token o refresh_token');
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    };
};

/**
 * Refresca el access token. Atlassian tiene refresh token rotation: devuelve
 * SIEMPRE un refresh token nuevo — el caller debe persistirlo antes de usar el access.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 * @throws {JiraReconnectRequiredError} si Atlassian responde 401 / invalid_grant.
 */
const refreshAccessToken = async (refreshToken) => {
    const response = await fetchWithRetry(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formUrlEncoded({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        }),
    }, { label: 'oauth/token (refresh)' });

    if (response.status === 401 || response.status === 403) {
        throw new JiraReconnectRequiredError('Atlassian rechazó el refresh token (invalid_grant)');
    }
    if (!response.ok) {
        const body = await parseJsonSafe(response);
        if (body && body.error === 'invalid_grant') {
            throw new JiraReconnectRequiredError('Atlassian rechazó el refresh token (invalid_grant)');
        }
        throw new JiraUpstreamError(`Atlassian respondió ${response.status} al refrescar el token`);
    }
    const data = await parseJsonSafe(response);
    if (!data || !data.access_token || !data.refresh_token) {
        throw new JiraUpstreamError('Respuesta de refresh sin access_token o refresh_token');
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    };
};

/**
 * Revoca el refresh token contra Atlassian. Best effort: cualquier error se loguea
 * y se ignora — la limpieza de credenciales locales no depende de esto.
 * @returns {Promise<boolean>} true si Atlassian confirmó la revocación.
 */
const revokeRefreshToken = async (refreshToken) => {
    try {
        const response = await fetchWithRetry(TOKEN_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formUrlEncoded({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                token: refreshToken,
                token_type_hint: 'refresh_token',
            }),
        }, { label: 'oauth/token/revoke' });
        return response.ok;
    } catch (error) {
        logger.warn('jira.revoke.failed', { error: error.message });
        return false;
    }
};

/**
 * Lista los sites Atlassian accesibles con el access token.
 * @returns {Promise<Array<{id: string, url: string, name: string, scopes: string[]}>>}
 */
const getAccessibleResources = async (accessToken) => {
    const response = await fetchWithRetry(ACCESSIBLE_RESOURCES_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, { label: 'accessible-resources' });

    if (!response.ok) {
        throw new JiraUpstreamError(`Atlassian respondió ${response.status} en accessible-resources`);
    }
    const data = await parseJsonSafe(response);
    return Array.isArray(data) ? data : [];
};

// ———————————————————— Jira REST API v3 ————————————————————

const apiGet = async (cloudId, accessToken, pathAndQuery, label) => {
    const url = `${jiraApiBaseUrl(cloudId)}${pathAndQuery}`;
    return fetchWithRetry(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, { label });
};

/**
 * Paginación genérica sobre endpoints de Jira REST API v3.
 * @param {Function} extractPage - recibe el JSON parseado y devuelve el array de items de la página.
 * @returns {Promise<Array>}
 */
const paginatedGet = async (cloudId, accessToken, path, label, extractPage) => {
    const items = [];
    let startAt = 0;
    while (true) {
        const query = new URLSearchParams({ startAt: String(startAt), maxResults: '100' });
        const response = await apiGet(cloudId, accessToken, `${path}?${query.toString()}`, label);
        if (response.status === 401 || response.status === 403) {
            throw new JiraReconnectRequiredError(`Token sin permisos para ${label}`);
        }
        if (!response.ok) {
            throw new JiraUpstreamError(`Atlassian respondió ${response.status} en ${label}`);
        }
        const data = await parseJsonSafe(response);
        const page = extractPage(data);
        items.push(...page);
        const total = Number(data?.total ?? items.length);
        startAt += 100;
        if (page.length === 0 || startAt >= total) {
            break;
        }
    }
    return items;
};

/**
 * @returns {Promise<{accountId: string, emailAddress: string, displayName: string}>}
 */
const getMyself = async (cloudId, accessToken) => {
    const response = await apiGet(cloudId, accessToken, '/myself', 'myself');
    if (response.status === 401 || response.status === 403) {
        throw new JiraReconnectRequiredError('Token sin permisos para /myself');
    }
    if (!response.ok) {
        throw new JiraUpstreamError(`Atlassian respondió ${response.status} en /myself`);
    }
    const data = await parseJsonSafe(response);
    return {
        accountId: data?.accountId ?? null,
        emailAddress: data?.emailAddress ?? null,
        displayName: data?.displayName ?? null,
    };
};

// JQL acepta milisegundos epoch en filtros de fecha. Lo usamos porque el formato
// string (`yyyy/MM/dd HH:mm`) lo interpreta Atlassian en la TZ del perfil del
// usuario, lo que producía ventanas corridas para usuarios fuera de UTC.
const toJqlEpoch = (date) => new Date(date).getTime();

// Tope defensivo de páginas para /search/jql. Atlassian tiene un bug conocido donde
// `isLast` puede no volverse `true` y `nextPageToken` cicla infinitamente
// (ver atlassian/atlassian-mcp-server#118). Con SEARCH_PAGE_SIZE=50 esto cubre 10k issues.
const MAX_SEARCH_PAGES = 200;

/**
 * Issues en los que el usuario actual PARTICIPA, actualizados dentro de la ventana, paginado.
 *
 * "Participa" = es assignee, reporter, creator o autor de algún worklog. No alcanza con
 * `assignee = currentUser()`: si el usuario crea un ticket y lo asigna a otra persona, o
 * loguea trabajo en un ticket ajeno, el ticket no aparecería y sus acciones (transición,
 * comentario, worklog del propio usuario) se perderían. El mapper igual filtra por autor,
 * así que ampliar el SET de tickets inspeccionados no atribuye acciones de terceros.
 *
 * Usa `GET /rest/api/3/search/jql` (el viejo `/search` fue retirado por Atlassian
 * en octubre 2025 — devuelve 410 Gone). Paginación por token: la respuesta trae
 * `nextPageToken` e `isLast`; no hay `total` ni `startAt`.
 *
 * @returns {Promise<Array<object>>} issues con `{ key, fields }`.
 */
const searchIssuesUpdatedInRange = async (cloudId, accessToken, dateStart, dateEnd) => {
    const participates = '(assignee = currentUser() OR reporter = currentUser() OR creator = currentUser() OR worklogAuthor = currentUser())';
    const jql = `${participates} AND updated >= ${toJqlEpoch(dateStart)} AND updated < ${toJqlEpoch(dateEnd)} ORDER BY updated ASC`;
    const issues = [];
    let nextPageToken = null;
    let pages = 0;

    while (pages < MAX_SEARCH_PAGES) {
        const query = new URLSearchParams({
            jql,
            maxResults: String(SEARCH_PAGE_SIZE),
            // `created`/`creator` permiten detectar tickets que el usuario creó dentro de la ventana.
            fields: 'summary,status,project,updated,created,creator',
        });
        if (nextPageToken) {
            query.set('nextPageToken', nextPageToken);
        }
        const response = await apiGet(cloudId, accessToken, `/search/jql?${query.toString()}`, 'search');
        if (response.status === 401 || response.status === 403) {
            throw new JiraReconnectRequiredError('Token sin permisos para /search/jql');
        }
        if (!response.ok) {
            throw new JiraUpstreamError(`Atlassian respondió ${response.status} en /search/jql`);
        }
        const data = await parseJsonSafe(response);
        const page = Array.isArray(data?.issues) ? data.issues : [];
        issues.push(...page);
        pages += 1;

        if (data?.isLast === true || !data?.nextPageToken || page.length === 0) {
            return issues;
        }
        nextPageToken = data.nextPageToken;
    }

    logger.warn('jira.search.page_cap_reached', { pages, collected: issues.length });
    return issues;
};

const getChangelog = (cloudId, accessToken, issueKey) =>
    paginatedGet(cloudId, accessToken, `/issue/${encodeURIComponent(issueKey)}/changelog`, 'changelog',
        (d) => Array.isArray(d?.values) ? d.values : []);

const getComments = (cloudId, accessToken, issueKey) =>
    paginatedGet(cloudId, accessToken, `/issue/${encodeURIComponent(issueKey)}/comment`, 'comment',
        (d) => Array.isArray(d?.comments) ? d.comments : []);

const getWorklogs = (cloudId, accessToken, issueKey) =>
    paginatedGet(cloudId, accessToken, `/issue/${encodeURIComponent(issueKey)}/worklog`, 'worklog',
        (d) => Array.isArray(d?.worklogs) ? d.worklogs : []);

module.exports = {
    buildAuthorizationUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    revokeRefreshToken,
    getAccessibleResources,
    getMyself,
    searchIssuesUpdatedInRange,
    getChangelog,
    getComments,
    getWorklogs,
    // Exportados para los tests (acelerar backoffs, reusar helpers):
    _internal: { RETRY, toJqlEpoch, fetchWithRetry },
};
