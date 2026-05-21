// Las constantes del módulo Jira leen estas envs al importarse — setearlas antes del require.
process.env.JIRA_CLIENT_ID = 'test-client-id';
process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
process.env.JIRA_REDIRECT_URI = 'http://localhost:3000/api/jira/auth/callback';
process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

const mapper = require('../../../src/modules/jira/jira.mapper');

const ME = 'acc-me-123';
const OTHER = 'acc-other-999';
const WINDOW_START = '2026-05-10T09:00:00.000Z';
const WINDOW_END = '2026-05-10T18:00:00.000Z';

const issue = {
    key: 'PROJ-42',
    fields: {
        summary: 'Arreglar el login',
        status: { name: 'In Progress' },
        project: { key: 'PROJ' },
    },
};

describe('jira.mapper', () => {
    describe('buildExternalId / isWithinWindow', () => {
        test('buildExternalId es determinista', () => {
            const a = mapper.buildExternalId('PROJ-1', 'comment', '2026-05-10T10:00:00.000Z');
            const b = mapper.buildExternalId('PROJ-1', 'comment', '2026-05-10T10:00:00.000Z');
            expect(a).toBe(b);
            expect(a).toBe('PROJ-1:comment:2026-05-10T10:00:00.000Z');
        });

        test('isWithinWindow incluye el borde inferior y excluye el superior', () => {
            expect(mapper.isWithinWindow(WINDOW_START, WINDOW_START, WINDOW_END)).toBe(true);
            expect(mapper.isWithinWindow(WINDOW_END, WINDOW_START, WINDOW_END)).toBe(false);
            expect(mapper.isWithinWindow('2026-05-10T08:59:59.999Z', WINDOW_START, WINDOW_END)).toBe(false);
            expect(mapper.isWithinWindow('not-a-date', WINDOW_START, WINDOW_END)).toBe(false);
        });
    });

    describe('mapCommentsToActivities', () => {
        test('happy path: comentarios míos dentro de la ventana', () => {
            const comments = [
                { id: 'c1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z' },
                { id: 'c2', author: { accountId: ME }, created: '2026-05-10T11:30:00.000Z' },
            ];
            const result = mapper.mapCommentsToActivities('user-1', issue, comments, ME, WINDOW_START, WINDOW_END);
            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({
                userId: 'user-1',
                source: 'jira',
                activityType: 'comment',
                externalId: 'PROJ-42:comment:2026-05-10T10:00:00.000Z',
            });
            expect(result[0].metadata).toMatchObject({
                issue_key: 'PROJ-42',
                summary: 'Arreglar el login',
                status: 'In Progress',
                project_key: 'PROJ',
                action_type: 'comment',
                comment_id: 'c1',
            });
            expect(result[0].startTime).toEqual(new Date('2026-05-10T10:00:00.000Z'));
            expect(result[0].endTime).toEqual(new Date('2026-05-10T10:00:00.000Z'));
        });

        test('descarta comentarios de otro autor o fuera de la ventana', () => {
            const comments = [
                { id: 'c1', author: { accountId: OTHER }, created: '2026-05-10T10:00:00.000Z' }, // no soy yo
                { id: 'c2', author: { accountId: ME }, created: '2026-05-10T08:30:00.000Z' }, // antes de la ventana
                { id: 'c3', author: { accountId: ME }, created: '2026-05-10T18:00:00.000Z' }, // borde superior excluido
                { id: 'c4', author: { accountId: ME }, created: '2026-05-10T12:00:00.000Z' }, // ✓
            ];
            const result = mapper.mapCommentsToActivities('user-1', issue, comments, ME, WINDOW_START, WINDOW_END);
            expect(result).toHaveLength(1);
            expect(result[0].externalId).toBe('PROJ-42:comment:2026-05-10T12:00:00.000Z');
        });

        test('input no-array → []', () => {
            expect(mapper.mapCommentsToActivities('u', issue, null, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });
    });

    describe('mapChangelogToActivities', () => {
        test('happy path: 2 transiciones de estado mías dentro de la ventana', () => {
            const histories = [
                {
                    id: 'h1',
                    author: { accountId: ME },
                    created: '2026-05-10T10:00:00.000Z',
                    items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
                },
                {
                    id: 'h2',
                    author: { accountId: ME },
                    created: '2026-05-10T16:00:00.000Z',
                    items: [
                        { field: 'assignee', fromString: 'x', toString: 'y' }, // no es status
                        { field: 'status', fromString: 'In Progress', toString: 'Done' },
                    ],
                },
            ];
            const result = mapper.mapChangelogToActivities('user-1', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({ activityType: 'transition', externalId: 'PROJ-42:transition:2026-05-10T10:00:00.000Z' });
            expect(result[0].metadata).toMatchObject({ from_status: 'To Do', to_status: 'In Progress', changelog_id: 'h1' });
            expect(result[1].metadata).toMatchObject({ from_status: 'In Progress', to_status: 'Done' });
        });

        test('descarta entries fuera de [dateStart, dateEnd) o de otro autor', () => {
            const histories = [
                { id: 'h1', author: { accountId: ME }, created: '2026-05-10T08:00:00.000Z', items: [{ field: 'status', fromString: 'a', toString: 'b' }] },
                { id: 'h2', author: { accountId: OTHER }, created: '2026-05-10T10:00:00.000Z', items: [{ field: 'status', fromString: 'a', toString: 'b' }] },
                { id: 'h3', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z', items: [{ field: 'description', fromString: 'a', toString: 'b' }] }, // no status
            ];
            expect(mapper.mapChangelogToActivities('user-1', issue, histories, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });
    });

    describe('mapWorklogsToActivities', () => {
        test('usa started + timeSpentSeconds para start/end', () => {
            const worklogs = [
                { id: 'w1', author: { accountId: ME }, started: '2026-05-10T14:00:00.000Z', timeSpentSeconds: 3600 },
            ];
            const result = mapper.mapWorklogsToActivities('user-1', issue, worklogs, ME, WINDOW_START, WINDOW_END);
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({ activityType: 'worklog', externalId: 'PROJ-42:worklog:2026-05-10T14:00:00.000Z' });
            expect(result[0].startTime).toEqual(new Date('2026-05-10T14:00:00.000Z'));
            expect(result[0].endTime).toEqual(new Date('2026-05-10T15:00:00.000Z'));
            expect(result[0].metadata).toMatchObject({ time_spent_seconds: 3600, worklog_id: 'w1' });
        });

        test('worklog sin timeSpentSeconds → endTime = startTime', () => {
            const worklogs = [{ id: 'w1', author: { accountId: ME }, started: '2026-05-10T14:00:00.000Z' }];
            const result = mapper.mapWorklogsToActivities('user-1', issue, worklogs, ME, WINDOW_START, WINDOW_END);
            expect(result[0].endTime).toEqual(new Date('2026-05-10T14:00:00.000Z'));
        });
    });

    describe('issueMetadata', () => {
        test('issue sin fields → todos los campos en null salvo issue_key', () => {
            expect(mapper.issueMetadata({ key: 'P-9' })).toEqual({ issue_key: 'P-9', summary: null, status: null, project_key: null });
        });

        test('issue nulo → todo null', () => {
            expect(mapper.issueMetadata(null)).toEqual({ issue_key: null, summary: null, status: null, project_key: null });
        });
    });

    describe('robustez de filtros', () => {
        test('changelog: history sin items[] no rompe', () => {
            const histories = [{ id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z' }];
            expect(mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });

        test('comentario sin author → descartado', () => {
            const comments = [{ id: 'c1', created: '2026-05-10T10:00:00.000Z' }];
            expect(mapper.mapCommentsToActivities('u', issue, comments, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });

        test('worklog sin author → descartado; inputs no-array → []', () => {
            const worklogs = [{ id: 'w1', started: '2026-05-10T12:00:00.000Z', timeSpentSeconds: 60 }];
            expect(mapper.mapWorklogsToActivities('u', issue, worklogs, ME, WINDOW_START, WINDOW_END)).toEqual([]);
            expect(mapper.mapWorklogsToActivities('u', issue, undefined, ME, WINDOW_START, WINDOW_END)).toEqual([]);
            expect(mapper.mapChangelogToActivities('u', issue, undefined, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });
    });

    describe('issueToActivities', () => {
        test('combina comentarios + transiciones + worklogs', () => {
            const input = {
                userId: 'user-1',
                issue,
                myAccountId: ME,
                comments: [{ id: 'c1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z' }],
                histories: [{ id: 'h1', author: { accountId: ME }, created: '2026-05-10T11:00:00.000Z', items: [{ field: 'status', fromString: 'a', toString: 'b' }] }],
                worklogs: [{ id: 'w1', author: { accountId: ME }, started: '2026-05-10T12:00:00.000Z', timeSpentSeconds: 1800 }],
            };
            const result = mapper.issueToActivities(input, WINDOW_START, WINDOW_END);
            expect(result.map((a) => a.activityType)).toEqual(['comment', 'transition', 'worklog']);
        });
    });
});
