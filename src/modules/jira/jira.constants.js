/**
 * Constantes y configuración del módulo Jira.
 *
 * La configuración sensible (client id/secret, redirect uri) se lee de variables
 * de entorno una sola vez, al importar el módulo. Si falta una variable crítica,
 * fallamos rápido — mismo patrón que `google.service.js`.
 *
 * Modelo de distribución: la plataforma es self-hosted single-tenant. Cada empresa
 * que despliega registra su propia app OAuth en developer.atlassian.com y configura
 * estas variables en su `.env`. No hay credenciales compartidas entre customers.
 */

const requireEnv = (name) => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} environment variable is required`);
    }
    return value;
};

// —— URLs base de Atlassian (constantes; nunca vienen del usuario) ——
const ATLASSIAN_AUTH_BASE_URL = 'https://auth.atlassian.com';
const ATLASSIAN_API_BASE_URL = 'https://api.atlassian.com';

const AUTHORIZE_URL = `${ATLASSIAN_AUTH_BASE_URL}/authorize`;
const TOKEN_URL = `${ATLASSIAN_AUTH_BASE_URL}/oauth/token`;
const TOKEN_REVOKE_URL = `${ATLASSIAN_AUTH_BASE_URL}/oauth/token/revoke`;
const ACCESSIBLE_RESOURCES_URL = `${ATLASSIAN_API_BASE_URL}/oauth/token/accessible-resources`;

/** Construye la base de la REST API v3 de Jira para un cloudId dado. */
const jiraApiBaseUrl = (cloudId) => `${ATLASSIAN_API_BASE_URL}/ex/jira/${cloudId}/rest/api/3`;

// —— OAuth 3LO ——
const DEFAULT_SCOPES = 'read:jira-work read:jira-user read:me offline_access';
const OAUTH_AUDIENCE = 'api.atlassian.com';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const OAUTH_STATE_BYTES = 32;

// —— Sync ——
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SYNC_MAX_WINDOW_HOURS = 24;
const SEARCH_PAGE_SIZE = 50;

// —— Fuente persistida en DailyActivity ——
const ACTIVITY_SOURCE = 'jira';

// Tipos de acción de Jira que mapeamos a DailyActivity.
// El /search se usa para descubrir QUÉ issues inspeccionar; las entradas
// persistidas son las acciones concretas del usuario dentro de la ventana.
const ACTIVITY_TYPE = {
    COMMENT: 'comment',
    TRANSITION: 'transition',
    WORKLOG: 'worklog',
};

// Validación del cloudId antes de interpolarlo en URLs (defensa SSRF — A10 OWASP)
const CLOUD_ID_REGEX = /^[a-zA-Z0-9-]+$/;

const config = {
    clientId: requireEnv('JIRA_CLIENT_ID'),
    clientSecret: requireEnv('JIRA_CLIENT_SECRET'),
    redirectUri: requireEnv('JIRA_REDIRECT_URI'),
    frontendBaseUrl: requireEnv('FRONTEND_BASE_URL'),
    scopes: process.env.JIRA_SCOPES || DEFAULT_SCOPES,
    requestTimeoutMs: Number(process.env.JIRA_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS,
    syncMaxWindowHours: Number(process.env.JIRA_SYNC_MAX_WINDOW_HOURS) || DEFAULT_SYNC_MAX_WINDOW_HOURS,
};

module.exports = {
    config,
    ATLASSIAN_AUTH_BASE_URL,
    ATLASSIAN_API_BASE_URL,
    AUTHORIZE_URL,
    TOKEN_URL,
    TOKEN_REVOKE_URL,
    ACCESSIBLE_RESOURCES_URL,
    jiraApiBaseUrl,
    DEFAULT_SCOPES,
    OAUTH_AUDIENCE,
    OAUTH_STATE_TTL_MS,
    OAUTH_STATE_BYTES,
    SEARCH_PAGE_SIZE,
    ACTIVITY_SOURCE,
    ACTIVITY_TYPE,
    CLOUD_ID_REGEX,
};
