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

const { ACTIVITY_SOURCE, ACTIVITY_TYPE, CHANGELOG_FIELD_TO_ACTIVITY_TYPE } = require('./jira.constants');
const { sanitizeText, MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS } = require('../../shared/utils/sanitize');

// Etiquetas legibles para los campos editables que agrupamos como EDIT genérico.
// Son frases nominales en participio (no verbos activos) para que el título
// `<summary> · <label>` no se lea como si el ticket fuera el sujeto que edita.
// Si el campo no está acá, cae a "campo actualizado" (defensivo; no debería pasar
// porque sólo llegan campos de CHANGELOG_FIELD_TO_ACTIVITY_TYPE).
const EDIT_FIELD_LABELS = {
    description: 'descripción actualizada',
    summary: 'título actualizado',
};

// —— Topes para inputs de Atlassian (defensa en profundidad) ——
// `summary` típicamente es <255 chars en Jira, pero un valor adversarial podría ser
// arbitrariamente grande. Truncamos antes de meterlo en la JSON column.
// `MAX_TITLE_CHARS` / `MAX_DESCRIPTION_CHARS` y el propio `sanitizeText` viven en el util
// compartido (`shared/utils/sanitize`), que también consumen Drive y Calendar.
const MAX_SUMMARY_CHARS = 120;
const MAX_STATUS_NAME_CHARS = 60;

// El árbol ADF de un comment puede tener cualquier profundidad. Acotamos visitas
// para evitar CPU exhaustion por un documento patológico (cualquier source externa
// es no confiable por default — Jira no es excepción).
const ADF_MAX_NODES = 1000;
const ADF_MAX_DEPTH = 20;

// —— Duración mínima de una actividad ——
// Acciones puntuales de Jira (comments, transitions) y worklogs con un timeSpent
// ínfimo tienen duración ~0, lo que las vuelve invisibles/inútiles en el timeline.
// Si la duración resultante es ≤ 60s, persistimos un default de 5 minutos.
const MIN_DURATION_SECONDS = 60;
const DEFAULT_DURATION_SECONDS = 5 * 60;

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
 *  - creation   → `Creó "<summary>" (<key>)`
 *  - assignment → `<summary> · asignada a <to>` (o `· sin asignar`) `(<key>)`
 *  - edit       → `<summary> · <campo actualizado> (<key>)`
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
    } else if (actionType === ACTIVITY_TYPE.CREATION) {
        raw = `Creó "${summaryPart}"${keySuffix}`;
    } else if (actionType === ACTIVITY_TYPE.ASSIGNMENT) {
        const to = sanitizeText(item?.toString, MAX_STATUS_NAME_CHARS);
        raw = to
            ? `${summaryPart} · asignada a ${to}${keySuffix}`
            : `${summaryPart} · sin asignar${keySuffix}`;
    } else if (actionType === ACTIVITY_TYPE.EDIT) {
        const label = EDIT_FIELD_LABELS[item?.field] || 'campo actualizado';
        raw = `${summaryPart} · ${label}${keySuffix}`;
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
    // Saneamos + truncamos también los campos espejo de Jira, no solo `title`/`description`.
    // Antes `summary` y `status` se persistían crudos en la JSON column: dejaban pasar
    // control chars y strings adversariales gigantes, contradiciendo el contrato del módulo.
    // `|| null` preserva el comportamiento previo: si tras sanear queda vacío, vuelve a null.
    issue_key: sanitizeText(issue?.key, 40) || null,
    summary: sanitizeText(issue?.fields?.summary, MAX_SUMMARY_CHARS) || null,
    status: sanitizeText(issue?.fields?.status?.name, MAX_STATUS_NAME_CHARS) || null,
    project_key: sanitizeText(issue?.fields?.project?.key, 40) || null,
});

const isMine = (author, myAccountId) => Boolean(author) && author.accountId === myAccountId;

const buildActivity = ({ userId, issue, actionType, timestamp, endTimestamp, title, description, extraMetadata, externalIdDiscriminator }) => {
    const iso = new Date(timestamp).toISOString();
    // Un mismo changelog entry (mismo timestamp) puede editar varios campos del mismo
    // tipo (p.ej. description y summary → ambos EDIT). Sin discriminador, sus externalId
    // colisionarían y `skipDuplicates` descartaría uno. El campo lo vuelve único.
    const externalId = externalIdDiscriminator
        ? `${issue.key}:${actionType}:${externalIdDiscriminator}:${iso}`
        : buildExternalId(issue.key, actionType, iso);
    const startMs = new Date(timestamp).getTime();
    const rawEndMs = new Date(endTimestamp ?? timestamp).getTime();
    // Si la duración es ≤ 60s (incluye las acciones puntuales con start === end),
    // aplicamos un mínimo de 5 minutos antes de persistir.
    const endMs = rawEndMs - startMs <= MIN_DURATION_SECONDS * 1000
        ? startMs + DEFAULT_DURATION_SECONDS * 1000
        : rawEndMs;
    return {
        userId,
        source: ACTIVITY_SOURCE,
        activityType: actionType,
        externalId,
        startTime: new Date(startMs),
        endTime: new Date(endMs),
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

/** Metadata específica por tipo de cambio del changelog. */
const buildChangelogMetadata = (actionType, item, history) => {
    const base = { changelog_id: history.id ?? null };
    if (actionType === ACTIVITY_TYPE.TRANSITION) {
        return { ...base, from_status: item.fromString ?? null, to_status: item.toString ?? null };
    }
    if (actionType === ACTIVITY_TYPE.ASSIGNMENT) {
        return { ...base, from_assignee: item.fromString ?? null, to_assignee: item.toString ?? null };
    }
    // EDIT: from/to pueden ser texto largo (description) → saneamos y truncamos.
    return {
        ...base,
        field: item.field ?? null,
        from: item.fromString != null ? sanitizeText(item.fromString, MAX_DESCRIPTION_CHARS) || null : null,
        to: item.toString != null ? sanitizeText(item.toString, MAX_DESCRIPTION_CHARS) || null : null,
    };
};

/**
 * Cambios del usuario en el changelog dentro de la ventana: transiciones de estado,
 * (re)asignaciones y ediciones de contenido (descripción, título). El tipo de
 * actividad se deriva del campo via `CHANGELOG_FIELD_TO_ACTIVITY_TYPE`; los campos no
 * mapeados se ignoran.
 * @param {object[]} histories - payload `values[]` de `/issue/{key}/changelog`.
 */
const mapChangelogToActivities = (userId, issue, histories, myAccountId, dateStart, dateEnd) => {
    if (!Array.isArray(histories)) return [];
    const activities = [];
    for (const history of histories) {
        if (!isMine(history.author, myAccountId) || !isWithinWindow(history.created, dateStart, dateEnd)) {
            continue;
        }
        const items = Array.isArray(history.items) ? history.items : [];
        for (const item of items) {
            const actionType = CHANGELOG_FIELD_TO_ACTIVITY_TYPE[item.field];
            if (!actionType) continue;
            const title = buildActivityTitle({ actionType, issue, item });
            activities.push(buildActivity({
                userId,
                issue,
                actionType,
                timestamp: history.created,
                title,
                // EDIT agrupa varios campos bajo un mismo tipo: discriminamos por campo
                // para no colisionar externalId cuando un cambio toca description + summary.
                externalIdDiscriminator: actionType === ACTIVITY_TYPE.EDIT ? item.field : undefined,
                extraMetadata: buildChangelogMetadata(actionType, item, history),
            }));
        }
    }
    return activities;
};

/**
 * Creación del ticket por el propio usuario dentro de la ventana. Jira no emite un
 * changelog entry para la creación, así que la inferimos de `fields.created` +
 * `fields.creator` (el search pide ambos campos explícitamente).
 */
const mapCreationToActivity = (userId, issue, myAccountId, dateStart, dateEnd) => {
    const created = issue?.fields?.created;
    const creator = issue?.fields?.creator;
    if (!isMine(creator, myAccountId) || !isWithinWindow(created, dateStart, dateEnd)) {
        return [];
    }
    const title = buildActivityTitle({ actionType: ACTIVITY_TYPE.CREATION, issue });
    return [buildActivity({
        userId,
        issue,
        actionType: ACTIVITY_TYPE.CREATION,
        timestamp: created,
        title,
        extraMetadata: { creator_account_id: creator.accountId ?? null },
    })];
};

/**
 * Worklogs del usuario dentro de la ventana. El `endTime` = `started` + `timeSpentSeconds`.
 * @param {object[]} worklogs - payload `worklogs[]` de `/issue/{key}/worklog`.
 */
const mapWorklogsToActivities = (userId, issue, worklogs, myAccountId, dateStart, dateEnd, defaultDuration) => {
    if (!Array.isArray(worklogs)) return [];

    const defaultDurationSeconds = (defaultDuration || 30) * 60; // defaultDuration viene en minutos, lo convertimos a segundos
    return worklogs
        .filter((w) => isMine(w.author, myAccountId) && isWithinWindow(w.started, dateStart, dateEnd))
        .map((w) => {
            const startedMs = ms(w.started);
           const originalSeconds = Number(w.timeSpentSeconds) || 0;
            let cappedSeconds = originalSeconds;
            if (originalSeconds > defaultDurationSeconds) {
                cappedSeconds = defaultDurationSeconds;
            }

            const endMs = startedMs + (cappedSeconds * 1000);
            const title = buildActivityTitle({ actionType: ACTIVITY_TYPE.WORKLOG, issue, durationSeconds: cappedSeconds });
            return buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.WORKLOG,
                timestamp: w.started,
                endTimestamp: endMs,
                title,
                extraMetadata: { 
                    time_spent_seconds: cappedSeconds, 
                    original_time_spent: originalSeconds,
                     worklog_id: w.id ?? null },
            });
        });
};

/**
 * Combina todas las fuentes de un issue en su lista de `DailyActivity`.
 * @param {{userId: string, issue: object, comments: object[], histories: object[], worklogs: object[], myAccountId: string}} input
 */
const issueToActivities = (input, dateStart, dateEnd) => {
    const { userId, issue, comments, histories, worklogs, myAccountId, defaultDuration } = input;
    return [
        ...mapCreationToActivity(userId, issue, myAccountId, dateStart, dateEnd),
        ...mapCommentsToActivities(userId, issue, comments, myAccountId, dateStart, dateEnd),
        ...mapChangelogToActivities(userId, issue, histories, myAccountId, dateStart, dateEnd),
        ...mapWorklogsToActivities(userId, issue, worklogs, myAccountId, dateStart, dateEnd, defaultDuration),
    ];
};

module.exports = {
    buildExternalId,
    isWithinWindow,
    issueMetadata,
    mapCreationToActivity,
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
        MAX_SUMMARY_CHARS,
        MAX_DESCRIPTION_CHARS,
        ADF_MAX_NODES,
        ADF_MAX_DEPTH,
        MIN_DURATION_SECONDS,
        DEFAULT_DURATION_SECONDS,
    },
};
