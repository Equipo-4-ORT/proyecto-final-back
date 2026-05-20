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
 */

const { ACTIVITY_SOURCE, ACTIVITY_TYPE } = require('./jira.constants');

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

const buildActivity = ({ userId, issue, actionType, timestamp, endTimestamp, extraMetadata }) => {
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
        .map((c) => buildActivity({
            userId,
            issue,
            actionType: ACTIVITY_TYPE.COMMENT,
            timestamp: c.created,
            extraMetadata: { comment_id: c.id ?? null },
        }));
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
            activities.push(buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.TRANSITION,
                timestamp: history.created,
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
            return buildActivity({
                userId,
                issue,
                actionType: ACTIVITY_TYPE.WORKLOG,
                timestamp: w.started,
                endTimestamp: startedMs + seconds * 1000,
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
};
