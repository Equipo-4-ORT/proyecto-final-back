/**
 * Transformaciones puras Atlassian → `DailyActivity`.
 *
 * No hace HTTP ni toca la BD. Recibe los payloads crudos de Atlassian + la
 * ventana `[dateStart, dateEnd)` y devuelve filas listas para `createMany`.
 *
 * Reglas (FRD §RN-11, RN-12):
 *  - Solo se importan acciones del propio usuario (`author === myAccountId`).
 *  - Solo si el timestamp cae dentro de `[dateStart, dateEnd)`.
 *  - Metadata mínima del ticket: issue_key, summary, status, project_key, action_type.
 *  - Metadata enriquecida: `title` y (cuando aplica) `description` legibles para el
 *    dashboard y para el módulo de IA — ambos consumen el contrato declarado en
 *    `ai.types.js`. Todo string ya viene saneado y truncado desde el mapper para que
 *    el front pueda renderizarlo directo (React auto-escapa) sin riesgo de XSS ni
 *    payloads adversariales.
 */

const { ACTIVITY_SOURCE, ACTIVITY_TYPE } = require('./jira.constants');

// —— Topes para inputs de Atlassian (defensa en profundidad) ——
// `summary` típicamente es <255 chars en Jira, pero un valor adversarial podría ser
// arbitrariamente grande. Truncamos antes de meterlo en la JSON column.
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SUMMARY_CHARS = 120;
const MAX_STATUS_NAME_CHARS = 60;

// El árbol ADF de un comment puede tener cualquier profundidad. Acotamos visitas
// para evitar CPU exhaustion por un documento patológico (cualquier source externa
// es no confiable por default — Jira no es excepción).
const ADF_MAX_NODES = 1000;
const ADF_MAX_DEPTH = 20;

/**
 * Normaliza texto que viene de Jira antes de persistirlo / exponerlo:
 *  - elimina control chars (0x00–0x1F, 0x7F) excepto whitespace común,
 *  - colapsa whitespace a un solo espacio,
 *  - trim,
 *  - trunca a `maxChars` (agrega ellipsis ASCII '...' si recorta).
 *
 * No escapa HTML: el contrato es que el consumidor (front React, AI) recibe
 * texto plano y lo renderiza por mecanismos que ya auto-escapan. Si en el
 * futuro alguien lo emite directo en HTML, debe escaparlo en ese punto.
 */
const sanitizeText = (value, maxChars) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Strip control chars excepto \t \n \r — se colapsan a espacio en el paso siguiente.
    // eslint-disable-next-line no-control-regex
    const stripped = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const collapsed = stripped.replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(maxChars) || maxChars <= 0 || collapsed.length <= maxChars) {
        return collapsed;
    }
    return `${collapsed.slice(0, Math.max(0, maxChars - 3))}...`;
};

/**
 * Extrae el texto plano de un documento Atlassian Document Format (ADF).
 *
 * ADF es un árbol JSON tipo `{ type, content?: Node[], text?: string, ... }`. Sólo
 * los nodos hoja con `type === 'text'` aportan contenido. Esta función:
 *  - recorre BFS-iterativo (sin recursión, evita stack overflow),
 *  - aplica node budget y depth budget para acotar CPU,
 *  - **no** ejecuta ni interpreta marks/atributos (un mark con `href` malicioso
 *    no llega al consumidor),
 *  - pasa por `sanitizeText` el string final.
 *
 * @param {unknown} body - payload ADF (o cualquier cosa; defensivo).
 * @param {number} maxChars - tope del string resultado.
 * @returns {string}
 */
const extractAdfText = (body, maxChars = MAX_DESCRIPTION_CHARS) => {
    if (!body || typeof body !== 'object') return '';
    const pieces = [];
    let totalLen = 0;
    let visited = 0;
    // Stack iterativo: { node, depth }
    const stack = [{ node: body, depth: 0 }];
    while (stack.length > 0 && visited < ADF_MAX_NODES) {
        const { node, depth } = stack.pop();
        visited += 1;
        if (!node || typeof node !== 'object' || depth > ADF_MAX_DEPTH) continue;
        if (typeof node.text === 'string' && node.text.length > 0) {
            pieces.push(node.text);
            totalLen += node.text.length;
            // Corte temprano: ya tenemos material suficiente para llenar maxChars.
            // Sumamos un colchón porque sanitizeText puede colapsar whitespace.
            if (totalLen > maxChars * 4) break;
        }
        if (Array.isArray(node.content)) {
            // Empujamos en orden inverso para mantener orden de lectura al hacer pop().
            for (let i = node.content.length - 1; i >= 0; i -= 1) {
                stack.push({ node: node.content[i], depth: depth + 1 });
            }
        }
    }
    return sanitizeText(pieces.join(' '), maxChars);
};

/** Convierte segundos a formato corto: `45m`, `1h 30m`, `2h`. */
const formatDuration = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

/**
 * Construye el título legible del DailyActivity. Pensado para reemplazar al literal
 * `activityType` que el front venía mostrando como título.
 *
 * Formato por tipo:
 *  - comment    → `Comentario en "<summary>" (<key>)`
 *  - transition → `<summary> · <from> → <to> (<key>)`
 *  - worklog    → `<summary> · <duration> (<key>)`
 *
 * Todos los componentes ya están saneados. La concatenación no inyecta HTML —
 * solo construye un string plano que el front renderiza vía React.
 *
 * @param {{ actionType: string, issue: object, item?: object, durationSeconds?: number }} input
 * @returns {string}
 */
const buildActivityTitle = ({ actionType, issue, item, durationSeconds }) => {
    const key = sanitizeText(issue?.key, 40);
    const summary = sanitizeText(issue?.fields?.summary, MAX_SUMMARY_CHARS);
    const summaryPart = summary || key || 'Ticket sin título';
    const keySuffix = key ? ` (${key})` : '';

    let raw;
    if (actionType === ACTIVITY_TYPE.COMMENT) {
        raw = `Comentario en "${summaryPart}"${keySuffix}`;
    } else if (actionType === ACTIVITY_TYPE.TRANSITION) {
        const from = sanitizeText(item?.fromString, MAX_STATUS_NAME_CHARS) || '?';
        const to = sanitizeText(item?.toString, MAX_STATUS_NAME_CHARS) || '?';
        raw = `${summaryPart} · ${from} → ${to}${keySuffix}`;
    } else if (actionType === ACTIVITY_TYPE.WORKLOG) {
        raw = `${summaryPart} · ${formatDuration(durationSeconds)}${keySuffix}`;
    } else {
        raw = summaryPart + keySuffix;
    }
    return sanitizeText(raw, MAX_TITLE_CHARS);
};

/** externalId determinista para idempotencia: "ISSUE-123:comment:2026-05-10T10:00:00.000Z". */
const buildExternalId = (issueKey, actionType, timestampIso) => `${issueKey}:${actionType}:${timestampIso}`;

const ms = (value) => new Date(value).getTime();

/** ¿`value` cae dentro de `[dateStart, dateEnd)`? */
const isWithinWindow = (value, dateStart, dateEnd) => {
    const t = ms(value);
    return Number.isFinite(t) && t >= ms(dateStart) && t < ms(dateEnd);
};

const issueMetadata = (issue) => ({
    issue_key: issue?.key ?? null,
    summary: issue?.fields?.summary ?? null,
    status: issue?.fields?.status?.name ?? null,
    project_key: issue?.fields?.project?.key ?? null,
});

const isMine = (author, myAccountId) => Boolean(author) && author.accountId === myAccountId;

const buildActivity = ({ userId, issue, actionType, timestamp, endTimestamp, title, description, extraMetadata }) => {
    const iso = new Date(timestamp).toISOString();
    return {
        userId,
        source: ACTIVITY_SOURCE,
        activityType: actionType,
        externalId: buildExternalId(issue.key, actionType, iso),
        startTime: new Date(timestamp),
        endTime: new Date(endTimestamp ?? timestamp),
        metadata: {
            ...issueMetadata(issue),
            action_type: actionType,
            // `title` / `description` siguen el contrato declarado en `ai.types.js`.
            // Se popula solo cuando hay un valor real para no contaminar metadata
            // con strings vacíos en activities ya importadas con formato viejo.
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(extraMetadata || {}),
        },
    };
};

/**
 * Comentarios del usuario dentro de la ventana.
 * @param {object[]} comments - payload `comments[]` de `/issue/{key}/comment`.
 */
const mapCommentsToActivities = (userId, issue, comments, myAccountId, dateStart, dateEnd) => {
    if (!Array.isArray(comments)) return [];
    return comments
        .filter((c) => isMine(c.author, myAccountId) && isWithinWindow(c.created, dateStart, dateEnd))
        .map((c) => {
            const title = buildActivityTitle({ actionType: ACTIVITY_TYPE.COMMENT, issue });
            const description = extractAdfText(c.body, MAX_DESCRIPTION_CHARS);
            return buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.COMMENT,
                timestamp: c.created,
                title,
                description,
                extraMetadata: { comment_id: c.id ?? null },
            });
        });
};

/**
 * Transiciones de estado del usuario dentro de la ventana.
 * @param {object[]} histories - payload `values[]` de `/issue/{key}/changelog`.
 */
const mapChangelogToActivities = (userId, issue, histories, myAccountId, dateStart, dateEnd) => {
    if (!Array.isArray(histories)) return [];
    const activities = [];
    for (const history of histories) {
        if (!isMine(history.author, myAccountId) || !isWithinWindow(history.created, dateStart, dateEnd)) {
            continue;
        }
        const statusItems = Array.isArray(history.items)
            ? history.items.filter((item) => item.field === 'status')
            : [];
        for (const item of statusItems) {
            const title = buildActivityTitle({ actionType: ACTIVITY_TYPE.TRANSITION, issue, item });
            activities.push(buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.TRANSITION,
                timestamp: history.created,
                title,
                extraMetadata: {
                    from_status: item.fromString ?? null,
                    to_status: item.toString ?? null,
                    changelog_id: history.id ?? null,
                },
            }));
        }
    }
    return activities;
};

/**
 * Worklogs del usuario dentro de la ventana. El `endTime` = `started` + `timeSpentSeconds`.
 * @param {object[]} worklogs - payload `worklogs[]` de `/issue/{key}/worklog`.
 */
const mapWorklogsToActivities = (userId, issue, worklogs, myAccountId, dateStart, dateEnd) => {
    if (!Array.isArray(worklogs)) return [];
    return worklogs
        .filter((w) => isMine(w.author, myAccountId) && isWithinWindow(w.started, dateStart, dateEnd))
        .map((w) => {
            const startedMs = ms(w.started);
            const seconds = Number(w.timeSpentSeconds) || 0;
            const title = buildActivityTitle({ actionType: ACTIVITY_TYPE.WORKLOG, issue, durationSeconds: seconds });
            return buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.WORKLOG,
                timestamp: w.started,
                endTimestamp: startedMs + seconds * 1000,
                title,
                extraMetadata: { time_spent_seconds: seconds, worklog_id: w.id ?? null },
            });
        });
};

/**
 * Combina todas las fuentes de un issue en su lista de `DailyActivity`.
 * @param {{userId: string, issue: object, comments: object[], histories: object[], worklogs: object[], myAccountId: string}} input
 */
const issueToActivities = (input, dateStart, dateEnd) => {
    const { userId, issue, comments, histories, worklogs, myAccountId } = input;
    return [
        ...mapCommentsToActivities(userId, issue, comments, myAccountId, dateStart, dateEnd),
        ...mapChangelogToActivities(userId, issue, histories, myAccountId, dateStart, dateEnd),
        ...mapWorklogsToActivities(userId, issue, worklogs, myAccountId, dateStart, dateEnd),
    ];
};

module.exports = {
    buildExternalId,
    isWithinWindow,
    issueMetadata,
    mapCommentsToActivities,
    mapChangelogToActivities,
    mapWorklogsToActivities,
    issueToActivities,
    // Helpers expuestos para tests. No son parte de la API pública del módulo:
    // ningún otro módulo del backend debería importarlos directamente.
    _internal: {
        sanitizeText,
        extractAdfText,
        buildActivityTitle,
        formatDuration,
        MAX_TITLE_CHARS,
        MAX_DESCRIPTION_CHARS,
        ADF_MAX_NODES,
        ADF_MAX_DEPTH,
    },
};
