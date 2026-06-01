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
            // Acción puntual (start === end): se aplica el mínimo de 5 minutos.
            expect(result[0].startTime).toEqual(new Date('2026-05-10T10:00:00.000Z'));
            expect(result[0].endTime).toEqual(new Date('2026-05-10T10:05:00.000Z'));
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
        test('happy path: 2 transiciones de estado mías dentro de la ventana (ignora campos no trackeados)', () => {
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
                        { field: 'labels', fromString: 'x', toString: 'y' }, // no trackeado → se ignora
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

        test('captura (re)asignaciones como activityType "assignment"', () => {
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'assignee', fromString: 'Juan', toString: 'Ana' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity).toMatchObject({ activityType: 'assignment', externalId: 'PROJ-42:assignment:2026-05-10T10:00:00.000Z' });
            expect(activity.metadata).toMatchObject({ from_assignee: 'Juan', to_assignee: 'Ana', changelog_id: 'h1' });
        });

        test('captura ediciones de descripción/título como "edit", discriminadas por campo en el externalId', () => {
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [
                    { field: 'description', fromString: 'viejo', toString: 'nuevo' },
                    { field: 'summary', fromString: 'Título viejo', toString: 'Título nuevo' },
                ],
            }];
            const result = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(result).toHaveLength(2);
            // Mismo timestamp + mismo tipo EDIT → el campo evita la colisión de externalId.
            expect(result.map((a) => a.externalId)).toEqual([
                'PROJ-42:edit:description:2026-05-10T10:00:00.000Z',
                'PROJ-42:edit:summary:2026-05-10T10:00:00.000Z',
            ]);
            expect(result[0]).toMatchObject({ activityType: 'edit' });
            expect(result[0].metadata).toMatchObject({ field: 'description', from: 'viejo', to: 'nuevo' });
        });

        test('descarta entries fuera de [dateStart, dateEnd) o de otro autor', () => {
            const histories = [
                { id: 'h1', author: { accountId: ME }, created: '2026-05-10T08:00:00.000Z', items: [{ field: 'status', fromString: 'a', toString: 'b' }] },
                { id: 'h2', author: { accountId: OTHER }, created: '2026-05-10T10:00:00.000Z', items: [{ field: 'status', fromString: 'a', toString: 'b' }] },
                { id: 'h3', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z', items: [{ field: 'labels', fromString: 'a', toString: 'b' }] }, // campo no trackeado
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

        test('worklog sin timeSpentSeconds → aplica el mínimo de 5 minutos (duración 0 ≤ 60s)', () => {
            const worklogs = [{ id: 'w1', author: { accountId: ME }, started: '2026-05-10T14:00:00.000Z' }];
            const result = mapper.mapWorklogsToActivities('user-1', issue, worklogs, ME, WINDOW_START, WINDOW_END);
            expect(result[0].startTime).toEqual(new Date('2026-05-10T14:00:00.000Z'));
            expect(result[0].endTime).toEqual(new Date('2026-05-10T14:05:00.000Z'));
        });

        test('worklog con timeSpentSeconds ≤ 60s → aplica el mínimo de 5 minutos', () => {
            const worklogs = [
                { id: 'w1', author: { accountId: ME }, started: '2026-05-10T14:00:00.000Z', timeSpentSeconds: 60 },
            ];
            const result = mapper.mapWorklogsToActivities('user-1', issue, worklogs, ME, WINDOW_START, WINDOW_END);
            expect(result[0].startTime).toEqual(new Date('2026-05-10T14:00:00.000Z'));
            expect(result[0].endTime).toEqual(new Date('2026-05-10T14:05:00.000Z'));
            // El metadata conserva el timeSpent original reportado por Jira.
            expect(result[0].metadata.time_spent_seconds).toBe(60);
        });
    });

    describe('mapCreationToActivity', () => {
        const createdIssue = {
            key: 'PROJ-42',
            fields: {
                summary: 'Arreglar el login',
                status: { name: 'To Do' },
                project: { key: 'PROJ' },
                created: '2026-05-10T10:00:00.000Z',
                creator: { accountId: ME },
            },
        };

        test('ticket creado por mí dentro de la ventana → activity "creation"', () => {
            const [activity] = mapper.mapCreationToActivity('user-1', createdIssue, ME, WINDOW_START, WINDOW_END);
            expect(activity).toMatchObject({
                activityType: 'creation',
                externalId: 'PROJ-42:creation:2026-05-10T10:00:00.000Z',
            });
            expect(activity.metadata.title).toBe('Creó "Arreglar el login" (PROJ-42)');
            expect(activity.metadata.creator_account_id).toBe(ME);
            // Acción puntual → mínimo de 5 minutos.
            expect(activity.startTime).toEqual(new Date('2026-05-10T10:00:00.000Z'));
            expect(activity.endTime).toEqual(new Date('2026-05-10T10:05:00.000Z'));
        });

        test('ticket creado por otro → no se importa', () => {
            const other = { ...createdIssue, fields: { ...createdIssue.fields, creator: { accountId: OTHER } } };
            expect(mapper.mapCreationToActivity('u', other, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });

        test('creación fuera de la ventana → no se importa', () => {
            const old = { ...createdIssue, fields: { ...createdIssue.fields, created: '2026-05-10T08:00:00.000Z' } };
            expect(mapper.mapCreationToActivity('u', old, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });

        test('issue sin creator/created → no rompe, devuelve []', () => {
            expect(mapper.mapCreationToActivity('u', { key: 'X-1', fields: {} }, ME, WINDOW_START, WINDOW_END)).toEqual([]);
            expect(mapper.mapCreationToActivity('u', null, ME, WINDOW_START, WINDOW_END)).toEqual([]);
        });
    });

    describe('issueMetadata', () => {
        test('issue sin fields → todos los campos en null salvo issue_key', () => {
            expect(mapper.issueMetadata({ key: 'P-9' })).toEqual({ issue_key: 'P-9', summary: null, status: null, project_key: null });
        });

        test('issue nulo → todo null', () => {
            expect(mapper.issueMetadata(null)).toEqual({ issue_key: null, summary: null, status: null, project_key: null });
        });

        test('summary/status crudos se sanean (control chars) y truncan antes de la JSON column', () => {
            const evil = {
                key: 'P-1',
                fields: {
                    summary: `Hola\x00\x07mundo${'A'.repeat(5000)}`,
                    status: { name: 'In\x1bProgress' },
                    project: { key: 'PROJ' },
                },
            };
            const meta = mapper.issueMetadata(evil);
            // eslint-disable-next-line no-control-regex
            expect(meta.summary).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
            expect(meta.status).toBe('InProgress');
            expect(meta.summary.length).toBeLessThanOrEqual(mapper._internal.MAX_SUMMARY_CHARS);
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

    describe('metadata.title (legibilidad para dashboard)', () => {
        test('comment: usa "Comentario en \\"<summary>\\" (<key>)"', () => {
            const comments = [{ id: 'c1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z' }];
            const [activity] = mapper.mapCommentsToActivities('u', issue, comments, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Comentario en "Arreglar el login" (PROJ-42)');
        });

        test('transition: usa "<summary> · <from> → <to> (<key>)"', () => {
            const histories = [{
                id: 'h1',
                author: { accountId: ME },
                created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Arreglar el login · In Progress → Done (PROJ-42)');
        });

        test('transition sin fromString/toString → fallback "?"', () => {
            const histories = [{
                id: 'h1',
                author: { accountId: ME },
                created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Arreglar el login · ? → ? (PROJ-42)');
        });

        test('worklog: usa "<summary> · <duration> (<key>)"', () => {
            const worklogs = [
                { id: 'w1', author: { accountId: ME }, started: '2026-05-10T14:00:00.000Z', timeSpentSeconds: 5400 },
            ];
            const [activity] = mapper.mapWorklogsToActivities('u', issue, worklogs, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Arreglar el login · 1h 30m (PROJ-42)');
        });

        test('assignment: usa "<summary> · asignada a <to> (<key>)"', () => {
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'assignee', fromString: 'Juan', toString: 'Ana' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Arreglar el login · asignada a Ana (PROJ-42)');
        });

        test('assignment sin destinatario (desasignación) → "sin asignar"', () => {
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'assignee', fromString: 'Ana', toString: null }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Arreglar el login · sin asignar (PROJ-42)');
        });

        test('edit: usa "<summary> · <campo actualizado> (<key>)" (frase nominal, sin verbo activo)', () => {
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [
                    { field: 'description', fromString: 'a', toString: 'b' },
                    { field: 'summary', fromString: 'x', toString: 'y' },
                ],
            }];
            const result = mapper.mapChangelogToActivities('u', issue, histories, ME, WINDOW_START, WINDOW_END);
            expect(result[0].metadata.title).toBe('Arreglar el login · descripción actualizada (PROJ-42)');
            expect(result[1].metadata.title).toBe('Arreglar el login · título actualizado (PROJ-42)');
        });

        test('creation: usa "Creó \\"<summary>\\" (<key>)"', () => {
            const createdIssue = {
                key: 'PROJ-42',
                fields: { summary: 'Arreglar el login', created: '2026-05-10T10:00:00.000Z', creator: { accountId: ME } },
            };
            const [activity] = mapper.mapCreationToActivity('u', createdIssue, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('Creó "Arreglar el login" (PROJ-42)');
        });

        test('issue sin summary → usa key como fallback', () => {
            const noSummary = { key: 'X-1', fields: { status: { name: 'Done' } } };
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status', fromString: 'a', toString: 'b' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', noSummary, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toBe('X-1 · a → b (X-1)');
        });
    });

    describe('metadata.description (ADF → texto plano)', () => {
        test('extrae texto de un body ADF anidado', () => {
            const body = {
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [
                        { type: 'text', text: 'Probé en staging' },
                        { type: 'text', text: ' y funciona.' },
                    ] },
                ],
            };
            const comments = [{ id: 'c1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z', body }];
            const [activity] = mapper.mapCommentsToActivities('u', issue, comments, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.description).toBe('Probé en staging y funciona.');
        });

        test('body ausente / null → no se setea description', () => {
            const comments = [{ id: 'c1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z' }];
            const [activity] = mapper.mapCommentsToActivities('u', issue, comments, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.description).toBeUndefined();
        });
    });

    describe('seguridad: input adversarial en summary / comment body', () => {
        test('payload tipo XSS en summary se conserva como texto plano (no escapado, no ejecutado)', () => {
            const evilIssue = {
                key: 'PROJ-99',
                fields: {
                    summary: '<script>alert(1)</script>',
                    status: { name: 'Done' },
                    project: { key: 'PROJ' },
                },
            };
            const histories = [{
                id: 'h1', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', evilIssue, histories, ME, WINDOW_START, WINDOW_END);
            // El backend NO escapa: emite texto plano. El consumidor (front React) auto-escapa al
            // renderizar y nunca interpreta esto como HTML.
            expect(activity.metadata.title).toContain('<script>alert(1)</script>');
            expect(activity.metadata.title).not.toMatch(/<script>.*<\/script>.*<script>/); // no duplicación
        });

        test('control chars (BEL, NUL, ESC) en summary son removidos antes de persistir', () => {
            // \x07, \x00, \x1b no son whitespace: tras strip los lados quedan adyacentes.
            // El espacio normal se preserva (colapsado a uno solo si hay varios).
            const evilIssue = {
                key: 'PROJ-100',
                fields: { summary: 'Hola\x07\x00mundo\x1b!', status: { name: 'X' }, project: { key: 'P' } },
            };
            const histories = [{
                id: 'h', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status', fromString: 'a', toString: 'b' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', evilIssue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title).toContain('Holamundo!');
            // eslint-disable-next-line no-control-regex
            expect(activity.metadata.title).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
        });

        test('summary gigantesco se trunca por debajo de MAX_TITLE_CHARS', () => {
            const giant = 'A'.repeat(5000);
            const evilIssue = { key: 'P-1', fields: { summary: giant, status: {}, project: {} } };
            const histories = [{
                id: 'h', author: { accountId: ME }, created: '2026-05-10T10:00:00.000Z',
                items: [{ field: 'status', fromString: 'x', toString: 'y' }],
            }];
            const [activity] = mapper.mapChangelogToActivities('u', evilIssue, histories, ME, WINDOW_START, WINDOW_END);
            expect(activity.metadata.title.length).toBeLessThanOrEqual(mapper._internal.MAX_TITLE_CHARS);
        });
    });

    describe('_internal.sanitizeText', () => {
        const { sanitizeText } = mapper._internal;

        test('null/undefined → ""', () => {
            expect(sanitizeText(null, 100)).toBe('');
            expect(sanitizeText(undefined, 100)).toBe('');
        });

        test('colapsa whitespace y hace trim', () => {
            expect(sanitizeText('  hola   mundo \t\n  ', 100)).toBe('hola mundo');
        });

        test('trunca con ellipsis cuando supera maxChars', () => {
            const out = sanitizeText('A'.repeat(50), 10);
            expect(out).toBe('AAAAAAA...');
            expect(out.length).toBe(10);
        });

        test('maxChars inválido o no provisto → no trunca', () => {
            expect(sanitizeText('hola', 0)).toBe('hola');
            expect(sanitizeText('hola')).toBe('hola');
        });

        test('inputs no-texto (objeto, función) → "" — evita el footgun de Object.prototype.toString', () => {
            expect(sanitizeText({}, 60)).toBe('');
            expect(sanitizeText(() => {}, 60)).toBe('');
            expect(sanitizeText({}.toString, 60)).toBe('');
        });
    });

    describe('_internal.extractAdfText', () => {
        const { extractAdfText, ADF_MAX_NODES, ADF_MAX_DEPTH } = mapper._internal;

        test('body no-objeto → ""', () => {
            expect(extractAdfText(null)).toBe('');
            expect(extractAdfText(undefined)).toBe('');
            expect(extractAdfText('string')).toBe('');
            expect(extractAdfText(42)).toBe('');
        });

        test('árbol con marks no ejecuta ni interpreta el atributo href', () => {
            // Un mark con href javascript: nunca debe llegar al consumidor porque
            // extractAdfText solo lee `text` y descarta atributos / marks.
            const body = {
                type: 'doc',
                content: [{
                    type: 'paragraph',
                    content: [{
                        type: 'text',
                        text: 'click aquí',
                        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                    }],
                }],
            };
            expect(extractAdfText(body)).toBe('click aquí');
        });

        test('árbol profundo más allá de ADF_MAX_DEPTH se corta sin lanzar', () => {
            // Construyo un árbol con depth = ADF_MAX_DEPTH + 5
            let node = { type: 'text', text: 'profundo' };
            for (let i = 0; i < ADF_MAX_DEPTH + 5; i += 1) {
                node = { type: 'wrap', content: [node] };
            }
            expect(() => extractAdfText(node)).not.toThrow();
        });

        test('árbol con más de ADF_MAX_NODES nodos se corta sin lanzar', () => {
            const content = [];
            for (let i = 0; i < ADF_MAX_NODES * 2; i += 1) {
                content.push({ type: 'text', text: 'x' });
            }
            const body = { type: 'doc', content };
            const out = extractAdfText(body, 100);
            expect(typeof out).toBe('string');
            expect(out.length).toBeLessThanOrEqual(100);
        });
    });

    describe('_internal.formatDuration', () => {
        const { formatDuration } = mapper._internal;
        test('0 → "0s"', () => expect(formatDuration(0)).toBe('0s'));
        test('45 → "45s"', () => expect(formatDuration(45)).toBe('45s'));
        test('60 → "1m"', () => expect(formatDuration(60)).toBe('1m'));
        test('3600 → "1h"', () => expect(formatDuration(3600)).toBe('1h'));
        test('5400 → "1h 30m"', () => expect(formatDuration(5400)).toBe('1h 30m'));
        test('negativos / NaN → "0s"', () => {
            expect(formatDuration(-10)).toBe('0s');
            expect(formatDuration('nope')).toBe('0s');
        });
    });
});
