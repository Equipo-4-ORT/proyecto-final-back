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
//
// Más allá de comentar / transicionar / loguear trabajo, capturamos el trabajo de
// gestión típico de un PL: crear tickets, asignarlos y editar su contenido. Todas
// estas acciones siguen atribuyéndose por autor (el usuario que las hizo), nunca a terceros.
const ACTIVITY_TYPE = {
    COMMENT: 'comment',
    TRANSITION: 'transition',
    WORKLOG: 'worklog',
    CREATION: 'creation',
    ASSIGNMENT: 'assignment',
    EDIT: 'edit',
};

// Campos del changelog de Jira que consideramos "trabajo real" y mapeamos a actividad.
// `status` y `assignee` tienen su propio tipo de alta señal; el resto de los campos de
// contenido (descripción, título) se agrupan como EDIT genérico. Agregar un campo nuevo
// es una sola línea acá; el mapper deriva el tipo y arma el título/metadata.
const CHANGELOG_FIELD_TO_ACTIVITY_TYPE = {
    status: ACTIVITY_TYPE.TRANSITION,
    assignee: ACTIVITY_TYPE.ASSIGNMENT,
    description: ACTIVITY_TYPE.EDIT,
    summary: ACTIVITY_TYPE.EDIT,
    Attachment: ACTIVITY_TYPE.EDIT,
    'Start date': ACTIVITY_TYPE.EDIT,
    duedate: ACTIVITY_TYPE.EDIT,
    labels: ACTIVITY_TYPE.EDIT,
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
    CHANGELOG_FIELD_TO_ACTIVITY_TYPE,
    CLOUD_ID_REGEX,
};
