process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';

const { google } = require('googleapis');
const {
    getDriveActivitiesForDay,
    persistDriveActivities,
    buildWorkEstimates,
    summarizeDriveActivities,
    enrichDriveActivitySummary,
    isCurrentUserActivity,
    InvalidWindowError,
    WORK_BUFFER_MS,
    MAX_WORK_DURATION_MS,
    MIME_TO_ACTIVITY_TYPE,
} = require('../../../src/modules/drive/drive-activity.service');
const { getAuthenticatedGoogleClient } = require('../../../src/modules/google/google.service');
const prisma = require('../../../src/shared/database/prisma');
const logger = require('../../../src/shared/utils/logger');

jest.mock('googleapis', () => ({
    google: {
        driveactivity: jest.fn(),
        drive: jest.fn(),
    },
}));
jest.mock('../../../src/modules/google/google.service');
jest.mock('../../../src/shared/database/prisma', () => ({
    dailyActivity: {
        // findMany se usa para separar creates de updates: por defecto no hay
        // registros previos (todos los upserts cuentan como create).
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
    },
    // El service persiste con upserts dentro de una transacción (array form).
    // El mock ejecuta las operaciones en paralelo y devuelve el array de resultados.
    $transaction: jest.fn((ops) => Promise.all(ops)),
}));
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));

// Actor que representa al propio empleado: la Drive Activity API lo marca con
// knownUser.isCurrentUser. persistDriveActivities solo persiste actividades con
// este actor (atribución RN-D02/D03). Las actividades de los tests llevan este
// actor salvo que prueben explícitamente el descarte de terceros.
const CURRENT_USER = { user: { knownUser: { isCurrentUser: true } } };

describe('Drive Activity Service', () => {
    let mockActivityQuery;
    let mockFilesGet;
    let mockFilesList;
    let mockDrivesList;

    beforeEach(() => {
        jest.clearAllMocks();

        getAuthenticatedGoogleClient.mockReturnValue({});

        mockActivityQuery = jest.fn();
        google.driveactivity.mockReturnValue({
            activity: { query: mockActivityQuery },
        });

        mockFilesGet = jest.fn();
        // Por defecto, sin unidades compartidas ni archivos "Compartido conmigo":
        // buildDriveScopes resuelve solo [{ ancestorName: 'items/root' }].
        mockFilesList = jest.fn().mockResolvedValue({ data: { files: [] } });
        mockDrivesList = jest.fn().mockResolvedValue({ data: { drives: [] } });
        google.drive.mockReturnValue({
            files: { get: mockFilesGet, list: mockFilesList },
            drives: { list: mockDrivesList },
        });
    });

    // ====================================================================
    // SUITE 1: getDriveActivitiesForDay — llamada a la API con paginación
    // ====================================================================
    describe('getDriveActivitiesForDay', () => {
        test('Devuelve array vacío si la API no retorna actividades', async () => {
            mockActivityQuery.mockResolvedValue({ data: {} });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            expect(result).toEqual([]);
            // 1 query principal + 7 queries por acción (EDIT, CREATE, RENAME, COMMENT,
            // PERMISSION_CHANGE, MOVE, DELETE) que se disparan en paralelo.
            expect(mockActivityQuery).toHaveBeenCalledTimes(8);
        });

        test('Devuelve las actividades de una sola página correctamente', async () => {
            const mockActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [mockActivity] } });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            // La query principal y las 7 por acción devuelven la misma actividad;
            // la dedup por fileId+actionType deja un solo resultado.
            expect(result).toHaveLength(1);
            expect(mockActivityQuery).toHaveBeenCalledTimes(8);
        });

        test('Maneja la paginación acumulando todas las páginas', async () => {
            const page1 = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            const page2 = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc2' } }],
                timestamp: '2026-05-26T14:00:00Z',
            };

            // Solo la query principal pagina; las queries por acción devuelven vacío.
            // (Se distinguen por el filtro: las por acción llevan action_detail_case.)
            mockActivityQuery.mockImplementation(({ requestBody }) => {
                if (requestBody.filter.includes('action_detail_case')) {
                    return Promise.resolve({ data: { activities: [] } });
                }
                if (!requestBody.pageToken) {
                    return Promise.resolve({ data: { activities: [page1], nextPageToken: 'token-pagina-2' } });
                }
                return Promise.resolve({ data: { activities: [page2] } });
            });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            // Ambas páginas de la query principal quedan acumuladas.
            expect(result).toHaveLength(2);
            // El token de la página 2 se reenvió en alguna de las llamadas.
            const tokenedCall = mockActivityQuery.mock.calls.find(
                (c) => c[0].requestBody.pageToken === 'token-pagina-2',
            );
            expect(tokenedCall).toBeDefined();
        });

        test('Corta la paginación al alcanzar el tope de páginas y loguea un warn', async () => {
            // nextPageToken nunca se vacía: simula el bug de token cíclico de la API.
            // Solo la query principal cicla; las por acción devuelven vacío y cortan.
            mockActivityQuery.mockImplementation(({ requestBody }) => {
                if (requestBody.filter.includes('action_detail_case')) {
                    return Promise.resolve({ data: { activities: [] } });
                }
                return Promise.resolve({ data: { activities: [], nextPageToken: 'loop' } });
            });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            // No entra en loop infinito: corta en MAX_PAGES (100).
            expect(result).toEqual([]);
            // 100 páginas de la principal + 7 queries por acción (una página cada una).
            expect(mockActivityQuery).toHaveBeenCalledTimes(107);
            expect(logger.warn).toHaveBeenCalledWith(
                'Tope de páginas de Drive Activity alcanzado',
                expect.objectContaining({ pages: 100 }),
            );
        });

        test('Si un scope falla, se omite y se loguea (recolección parcial, no aborta)', async () => {
            // RN-D05: el fallo de la consulta de un scope no aborta la recolección.
            // Con un solo scope (Mi unidad) que falla, devuelve [] y loguea el skip.
            mockActivityQuery.mockRejectedValue(new Error('Google API caída'));

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            expect(result).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(
                'Scope de Drive omitido por error en la consulta',
                expect.objectContaining({ message: 'Google API caída' }),
            );
        });
    });

    // ====================================================================
    // SUITE 2: buildWorkEstimates — lógica de estimación de duración pura
    // ====================================================================
    describe('buildWorkEstimates', () => {
        const USER_ID = 'user-uuid-123';
        const WINDOW_DATE = '2026-05-26';

        // Helper: arma una entrada byFile con la forma nueva (intervals + actionType).
        const entry = (overrides) => ({
            fileId: 'doc1',
            actionType: 'edit',
            mimeType: 'application/vnd.google-apps.document',
            title: 'Doc',
            intervals: [{ startMs: new Date('2026-05-26T10:00:00.000Z').getTime(), endMs: null }],
            ...overrides,
        });

        test('acción continua única: endTime = startMs + buffer de 5 min', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([['doc1__edit', entry({ intervals: [{ startMs: tsMs, endMs: null }] })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.startTime).toEqual(new Date(tsMs));
            expect(record.endTime).toEqual(new Date(tsMs + WORK_BUFFER_MS));
        });

        test('varias acciones en una sesión: startTime = primera, endTime = última (sin endMs no se suma buffer)', () => {
            const t1 = new Date('2026-05-26T10:00:00.000Z').getTime();
            const t2 = new Date('2026-05-26T10:30:00.000Z').getTime();
            const t3 = new Date('2026-05-26T11:00:00.000Z').getTime();
            const byFile = new Map([['doc1__edit', entry({
                title: null, mimeType: null,
                intervals: [{ startMs: t2, endMs: null }, { startMs: t1, endMs: null }, { startMs: t3, endMs: null }],
            })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            // Gaps de 30 min: misma sesión. El buffer solo actúa como piso de duración,
            // así que el endTime cae en la última acción, no en última + buffer.
            expect(record.startTime).toEqual(new Date(t1));
            expect(record.endTime).toEqual(new Date(t3));
        });

        test('respeta el tope de 2 h cuando el rango de la sesión lo supera', () => {
            const t1 = new Date('2026-05-26T09:00:00.000Z').getTime();
            // Un único intervalo con endMs 5 h después (la API devolvió timeRange largo).
            const byFile = new Map([['doc1__edit', entry({
                intervals: [{ startMs: t1, endMs: t1 + 5 * 60 * 60 * 1000 }],
            })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            const durationMs = record.endTime.getTime() - record.startTime.getTime();
            expect(durationMs).toBe(MAX_WORK_DURATION_MS);
        });

        test('externalId incluye la acción: file_<fileId>_<actionType>_<YYYY-MM-DD>', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([['doc1__edit', entry({
                mimeType: null, title: null, intervals: [{ startMs: tsMs, endMs: null }],
            })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.externalId).toBe('file_doc1_edit_2026-05-26');
        });

        test('activityType es la acción y fileType se deriva del mimeType; source siempre es "drive"', () => {
            const byFile = new Map([['doc1__edit', entry({ title: null })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.activityType).toBe('edit');
            expect(record.fileType).toBe('document');
            expect(record.source).toBe('drive');
        });

        test('fileType es "file" para mimeTypes no nativos de Workspace (PDF, imagen, etc.)', () => {
            const byFile = new Map([['pdf1__edit', entry({ fileId: 'pdf1', mimeType: 'application/pdf', title: null })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.fileType).toBe('file');
        });

        test('fileType es "file" cuando mimeType es null', () => {
            const byFile = new Map([['file1__edit', entry({ fileId: 'file1', mimeType: null, title: null })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.fileType).toBe('file');
        });

        test('cubre todos los tipos nativos de Workspace en fileType: spreadsheet, presentation, form, drawing, script', () => {
            const cases = [
                ['application/vnd.google-apps.spreadsheet',  'spreadsheet'],
                ['application/vnd.google-apps.presentation', 'presentation'],
                ['application/vnd.google-apps.form',         'form'],
                ['application/vnd.google-apps.drawing',      'drawing'],
                ['application/vnd.google-apps.script',       'script'],
            ];

            cases.forEach(([mimeType, expectedType]) => {
                const byFile = new Map([['f1__edit', entry({ fileId: 'f1', mimeType, title: null })]]);
                const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);
                expect(record.fileType).toBe(expectedType);
            });
        });

        test('genera un registro por entrada archivo+acción', () => {
            const t1 = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([
                ['doc1__edit', entry({ fileId: 'doc1', mimeType: null, title: null, intervals: [{ startMs: t1, endMs: null }, { startMs: t1 + 1000, endMs: null }] })],
                ['doc2__edit', entry({ fileId: 'doc2', mimeType: null, title: null, intervals: [{ startMs: t1 + 2000, endMs: null }] })],
            ]);

            const records = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(records).toHaveLength(2);
        });

        test('incluye fileId, mimeType y title (con verbo) en metadata', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const mimeType = 'application/vnd.google-apps.spreadsheet';
            const byFile = new Map([['sheet1__edit', entry({
                fileId: 'sheet1', mimeType, title: 'Mi hoja', intervals: [{ startMs: tsMs, endMs: null }],
            })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.metadata).toEqual({ title: 'Editó "Mi hoja"', fileId: 'sheet1', mimeType });
        });

        test('el title de primer nivel antepone el verbo de la acción al nombre del archivo', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([['doc1__edit', entry({ title: 'Mi informe', intervals: [{ startMs: tsMs, endMs: null }] })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.title).toBe('Editó "Mi informe"');
        });

        test('title de primer nivel es solo el verbo cuando el archivo no tiene nombre', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([['doc1__edit', entry({ title: null, intervals: [{ startMs: tsMs, endMs: null }] })]]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.title).toBe('Editó');
        });
    });

    // ====================================================================
    // SUITE 3: persistDriveActivities — ventana, filtros, agrupación y persistencia
    // ====================================================================
    describe('persistDriveActivities', () => {
        const mockUserId = 'user-uuid-123';
        // Ventana de un día para un usuario en UTC-3 (jornada del 2026-05-26 en BsAs).
        const startTime = '2026-05-26T03:00:00.000Z';
        const endTime = '2026-05-27T03:00:00.000Z';

        test('Usa la ventana [startTime, endTime) recibida en el filtro de la API', async () => {
            mockActivityQuery.mockResolvedValue({ data: { activities: [] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const { filter } = mockActivityQuery.mock.calls[0][0].requestBody;
            expect(filter).toBe('time >= "2026-05-26T03:00:00.000Z" AND time < "2026-05-27T03:00:00.000Z"');
        });

        test('Lanza InvalidWindowError si startTime >= endTime (sin llamar a la API)', async () => {
            await expect(
                persistDriveActivities(mockUserId, 'token', '2026-05-27T00:00:00Z', '2026-05-26T00:00:00Z')
            ).rejects.toBeInstanceOf(InvalidWindowError);
            expect(mockActivityQuery).not.toHaveBeenCalled();
        });

        test('Lanza InvalidWindowError si las fechas no son parseables', async () => {
            await expect(
                persistDriveActivities(mockUserId, 'token', 'no-es-fecha', '2026-05-26T00:00:00Z')
            ).rejects.toBeInstanceOf(InvalidWindowError);
            expect(mockActivityQuery).not.toHaveBeenCalled();
        });

        test('Lanza InvalidWindowError si la ventana supera el tope de 31 días (sin llamar a la API)', async () => {
            // 40 días: por encima del máximo permitido.
            await expect(
                persistDriveActivities(mockUserId, 'token', '2026-05-01T00:00:00Z', '2026-06-10T00:00:00Z')
            ).rejects.toBeInstanceOf(InvalidWindowError);
            expect(mockActivityQuery).not.toHaveBeenCalled();
        });

        test('Persiste todas las acciones (rename, move, delete, comment) como registros separados', async () => {
            // Ya no se filtran por tipo: cada acción sobre el archivo genera su registro.
            const activities = ['rename', 'move', 'delete', 'comment'].map(type => ({
                primaryActionDetail: { [type]: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            }));
            mockActivityQuery.mockResolvedValue({ data: { activities } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(4);
            const actions = getUpsertedRecords().map((r) => r.activityType).sort();
            expect(actions).toEqual(['comment', 'delete', 'move', 'rename']);
        });

        test('Filtra archivos de tipo carpeta y acceso directo', async () => {
            const excluded = [
                { mimeType: 'application/vnd.google-apps.folder', name: 'items/folder1', title: 'Carpeta' },
                { mimeType: 'application/vnd.google-apps.shortcut', name: 'items/sc1', title: 'Acceso directo' },
            ].map(driveItem => ({
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            }));
            mockActivityQuery.mockResolvedValue({ data: { activities: excluded } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(0);
            expect(prisma.dailyActivity.upsert).not.toHaveBeenCalled();
        });

        // ── Agrupación por archivo+acción (comportamiento nuevo) ──────────────

        // Helper: extrae el campo `create` de cada upsert llamado
        const getUpsertedRecords = () =>
            prisma.dailyActivity.upsert.mock.calls.map((call) => call[0].create);

        test('Un archivo con una acción: persiste UN registro con activityType=acción y fileType derivado del mimeType', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Mi Documento', mimeType: 'application/vnd.google-apps.document' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(1);
            const data = getUpsertedRecords();
            expect(data).toHaveLength(1);
            expect(data[0]).toMatchObject({ source: 'drive', activityType: 'edit', fileType: 'document', userId: mockUserId });
            expect(data[0].title).toBe('Editó "Mi Documento"');
            expect(data[0].metadata).toMatchObject({ title: 'Editó "Mi Documento"', fileId: 'doc1' });
        });

        test('Acción "create" en spreadsheet: activityType="create", fileType="spreadsheet"', async () => {
            const activity = {
                primaryActionDetail: { create: { new: {} } },
                targets: [{ driveItem: { name: 'items/sheet1', title: 'Nueva Planilla', mimeType: 'application/vnd.google-apps.spreadsheet' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T14:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);
            const record = getUpsertedRecords()[0];
            expect(record.activityType).toBe('create');
            expect(record.fileType).toBe('spreadsheet');
        });

        test('Archivo sin mimeType nativo (PDF): fileType="file"', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/pdf1', title: 'contrato.pdf', mimeType: 'application/pdf' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);
            expect(getUpsertedRecords()[0].fileType).toBe('file');
        });

        test('Dos archivos distintos → dos registros (uno por archivo)', async () => {
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T10:00:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/sheet1', title: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T11:00:00Z' },
                    ],
                },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = getUpsertedRecords();
            expect(data).toHaveLength(2);
            const fileIds = data.map((r) => r.metadata.fileId).sort();
            expect(fileIds).toEqual(['doc1', 'sheet1']);
        });

        test('Un archivo con varias acciones → UN solo registro (no uno por acción)', async () => {
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T10:00:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T10:15:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T10:45:00Z' },
                    ],
                },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(getUpsertedRecords()).toHaveLength(1);
        });

        test('startTime = primera acción de la sesión, endTime = última (sin endMs no se suma buffer)', async () => {
            const t1 = '2026-05-26T10:00:00.000Z';
            const t3 = '2026-05-26T10:45:00.000Z';
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: t1 },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: '2026-05-26T10:20:00.000Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], actors: [CURRENT_USER], timestamp: t3 },
                    ],
                },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = getUpsertedRecords()[0];
            expect(record.startTime).toEqual(new Date(t1));
            expect(record.endTime).toEqual(new Date(t3));
        });

        test('Sesión continua larga: endTime no supera el tope de 2 h', async () => {
            const t1 = '2026-05-26T09:00:00.000Z';
            // timeRange de 5 h: una sola actividad cuya duración se recorta al tope de 2 h.
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [{
                        primaryActionDetail: { edit: {} },
                        targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                        actors: [CURRENT_USER],
                        timeRange: { startTime: t1, endTime: '2026-05-26T14:00:00.000Z' },
                    }],
                },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = getUpsertedRecords()[0];
            const durationMs = record.endTime.getTime() - record.startTime.getTime();
            expect(durationMs).toBe(MAX_WORK_DURATION_MS);
        });

        test('Actividad con timeRange: startTime = inicio del rango, endTime = fin del rango', async () => {
            const rangeStart = '2026-05-26T10:00:00.000Z';
            const rangeEnd   = '2026-05-26T10:20:00.000Z';
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [{
                        primaryActionDetail: { edit: {} },
                        targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                        actors: [CURRENT_USER],
                        timeRange: { startTime: rangeStart, endTime: rangeEnd },
                    }],
                },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = getUpsertedRecords()[0];
            expect(record.startTime).toEqual(new Date(rangeStart));
            expect(record.endTime).toEqual(new Date(rangeEnd));
        });

        test('Construye externalId estable file_<fileId>_<actionType>_<YYYY-MM-DD>', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            // windowDate se toma del inicio de la ventana: 2026-05-26
            expect(getUpsertedRecords()[0].externalId).toBe('file_doc1_edit_2026-05-26');
        });

        test('upsert idempotente: el mismo sync dos veces preserva el id de BD y actualiza duración', async () => {
            mockActivityQuery.mockResolvedValue({
                data: { activities: [{
                    primaryActionDetail: { edit: {} },
                    targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                    actors: [CURRENT_USER],
                    timestamp: '2026-05-26T10:00:00Z',
                }] },
            });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            // El upsert usa el unique key userId_source_externalId
            const call = prisma.dailyActivity.upsert.mock.calls[0][0];
            expect(call.where).toEqual({
                userId_source_externalId: {
                    userId: mockUserId,
                    source: 'drive',
                    externalId: 'file_doc1_edit_2026-05-26',
                },
            });
            // El campo update incluye startTime y endTime (recalculados) pero no externalId ni userId
            expect(call.update).toHaveProperty('startTime');
            expect(call.update).toHaveProperty('endTime');
            expect(call.update).not.toHaveProperty('externalId');
            // Ocurre dentro de una transacción
            expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        });

        test('sanea + trunca el title del archivo (control chars y longitud) antes de persistir', async () => {
            const evilActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: `Doc\x00\x07umento${'C'.repeat(5000)}`, mimeType: 'application/vnd.google-apps.document' } }],
                actors: [CURRENT_USER],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [evilActivity] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const saved = getUpsertedRecords()[0];
            // eslint-disable-next-line no-control-regex
            expect(saved.metadata.title).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
            // El title final antepone el verbo y entrecomilla el nombre saneado del archivo.
            expect(saved.metadata.title.startsWith('Editó "Documento')).toBe(true);
            // El nombre del archivo (entre comillas) quedó truncado a MAX_TITLE_CHARS (200).
            const fileName = saved.metadata.title.match(/^Editó "(.*)"$/)[1];
            expect(fileName.length).toBeLessThanOrEqual(200);
        });

        test('Devuelve created/updated en 0 y mensaje cuando no hay actividades relevantes', async () => {
            mockActivityQuery.mockResolvedValue({ data: { activities: [] } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result).toEqual({
                created: 0,
                updated: 0,
                message: 'No se encontraron actividades relevantes de Drive para guardar',
            });
            expect(prisma.dailyActivity.upsert).not.toHaveBeenCalled();
        });
    });

    // ====================================================================
    // SUITE 3: summarizeDriveActivities — agrupación y conteo por archivo
    // ====================================================================
    describe('summarizeDriveActivities', () => {
        const docActivity = (actionType, fileId = 'doc1', title = 'Documento') => ({
            primaryActionDetail: { [actionType]: {} },
            targets: [{ driveItem: { name: `items/${fileId}`, title, mimeType: 'application/vnd.google-apps.document' } }],
            timestamp: '2026-05-26T10:00:00Z',
        });

        test('Devuelve array vacío cuando no hay actividades', () => {
            expect(summarizeDriveActivities([])).toEqual([]);
        });

        test('Agrupa varias acciones del mismo archivo en una sola entrada', () => {
            const activities = [
                docActivity('edit'),
                docActivity('edit'),
                docActivity('comment'),
            ];

            const result = summarizeDriveActivities(activities);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                fileId: 'doc1',
                editCount: 2,
                commentCount: 1,
                shareCount: 0,
                totalActions: 3,
            });
        });

        test('Genera una entrada por archivo distinto', () => {
            const activities = [
                docActivity('edit', 'doc1'),
                docActivity('edit', 'doc2'),
                docActivity('comment', 'doc1'),
            ];

            const result = summarizeDriveActivities(activities);

            expect(result).toHaveLength(2);
            const ids = result.map((r) => r.fileId).sort();
            expect(ids).toEqual(['doc1', 'doc2']);
        });

        test('Cuenta "create" dentro de editCount', () => {
            const result = summarizeDriveActivities([docActivity('create')]);

            expect(result[0].editCount).toBe(1);
            expect(result[0].totalActions).toBe(1);
        });

        test('Cuenta permissionChange como shareCount', () => {
            const result = summarizeDriveActivities([docActivity('permissionChange')]);

            expect(result[0].shareCount).toBe(1);
            expect(result[0].totalActions).toBe(1);
        });

        test('Cuenta rename como editCount y move/delete como shareCount', () => {
            const activities = ['rename', 'move', 'delete'].map((t) => docActivity(t));

            const [entry] = summarizeDriveActivities(activities);

            // rename ∈ EDIT_ACTIONS; move y delete ∈ SHARE_ACTIONS.
            expect(entry.editCount).toBe(1);
            expect(entry.shareCount).toBe(2);
            expect(entry.commentCount).toBe(0);
            expect(entry.totalActions).toBe(3);
        });

        test('Excluye carpetas y accesos directos del resumen', () => {
            const folder = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/folder1', title: 'Carpeta', mimeType: 'application/vnd.google-apps.folder' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            const shortcut = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/sc1', title: 'Acceso directo', mimeType: 'application/vnd.google-apps.shortcut' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };

            expect(summarizeDriveActivities([folder, shortcut])).toEqual([]);
        });

        test('Incluye title y mimeType del archivo en cada entrada', () => {
            const result = summarizeDriveActivities([docActivity('edit', 'doc1', 'Mi Informe')]);

            expect(result[0].title).toBe('Mi Informe');
            expect(result[0].mimeType).toBe('application/vnd.google-apps.document');
        });

        test('Sanea el title antes de incluirlo en el resumen', () => {
            const evil = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: `Doc\x00\x07umento${'C'.repeat(5000)}`, mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };

            const [entry] = summarizeDriveActivities([evil]);

            // eslint-disable-next-line no-control-regex
            expect(entry.title).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
            expect(entry.title.length).toBeLessThanOrEqual(200);
        });

        test('Calcula totalActions como suma de los tres contadores', () => {
            const activities = [
                docActivity('edit'),
                docActivity('comment'),
                docActivity('permissionChange'),
                docActivity('create'),
            ];

            const [entry] = summarizeDriveActivities(activities);

            expect(entry.editCount).toBe(2);   // edit + create
            expect(entry.commentCount).toBe(1);
            expect(entry.shareCount).toBe(1);
            expect(entry.totalActions).toBe(4);
        });

        test('Ignora actividades sin target driveItem', () => {
            const noTarget = {
                primaryActionDetail: { edit: {} },
                targets: [],
                timestamp: '2026-05-26T10:00:00Z',
            };

            expect(summarizeDriveActivities([noTarget])).toEqual([]);
        });
    });

    // ====================================================================
    // SUITE 4: Escenarios de negocio — solo comentarios, archivos
    //          compartidos y ediciones simultáneas
    // ====================================================================
    describe('Escenarios de negocio', () => {
        const mockUserId = 'user-uuid-123';
        const startTime  = '2026-05-26T03:00:00.000Z';
        const endTime    = '2026-05-27T03:00:00.000Z';

        // Helpers locales
        const makeActivity = (actionType, fileId, title, mimeType = 'application/vnd.google-apps.document', ts = '2026-05-26T10:00:00.000Z') => ({
            primaryActionDetail: { [actionType]: {} },
            targets: [{ driveItem: { name: `items/${fileId}`, title, mimeType } }],
            actors: [CURRENT_USER],
            timestamp: ts,
        });

        // ------------------------------------------------------------------
        // Solo comentarios
        // ------------------------------------------------------------------
        describe('Solo comentarios', () => {
            test('Un archivo con comentarios en sesiones separadas: persiste un registro por sesión', async () => {
                // Dos comentarios con 1 h de gap (> SESSION_GAP_MS) → dos sesiones.
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('comment', 'doc1', 'Informe'),
                            makeActivity('comment', 'doc1', 'Informe', 'application/vnd.google-apps.document', '2026-05-26T11:00:00.000Z'),
                        ],
                    },
                });

                const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                expect(result.created).toBe(2);
                const data = prisma.dailyActivity.upsert.mock.calls.map((c) => c[0].create);
                expect(data.every((r) => r.activityType === 'comment')).toBe(true);
            });

            test('Varios archivos con comentarios: cada uno se persiste', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('comment', 'doc1', 'Doc A'),
                            makeActivity('comment', 'doc2', 'Doc B'),
                            makeActivity('comment', 'doc3', 'Doc C'),
                        ],
                    },
                });

                const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                expect(result.created).toBe(3);
                const fileIds = prisma.dailyActivity.upsert.mock.calls.map((c) => c[0].create.metadata.fileId).sort();
                expect(fileIds).toEqual(['doc1', 'doc2', 'doc3']);
            });

            test('Comentarios mezclados con edits: se persiste un registro por archivo+acción', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('comment', 'doc1', 'Solo comentado'),
                            makeActivity('edit',    'doc2', 'Editado',          'application/vnd.google-apps.spreadsheet'),
                            makeActivity('comment', 'doc2', 'Editado y comentado', 'application/vnd.google-apps.spreadsheet'),
                        ],
                    },
                });

                const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                // doc1+comment, doc2+edit, doc2+comment → 3 registros.
                expect(result.created).toBe(3);
                const keys = prisma.dailyActivity.upsert.mock.calls
                    .map((c) => `${c[0].create.metadata.fileId}__${c[0].create.activityType}`)
                    .sort();
                expect(keys).toEqual(['doc1__comment', 'doc2__comment', 'doc2__edit']);
            });

            test('summarizeDriveActivities sí incluye archivos con solo comentarios (comment ∈ SUMMARY_ACTIONS)', () => {
                const raw = [
                    makeActivity('comment', 'doc1', 'Informe'),
                    makeActivity('comment', 'doc1', 'Informe', 'application/vnd.google-apps.document', '2026-05-26T11:00:00.000Z'),
                ];

                const result = summarizeDriveActivities(raw);

                expect(result).toHaveLength(1);
                expect(result[0].fileId).toBe('doc1');
                expect(result[0].commentCount).toBe(2);
                expect(result[0].editCount).toBe(0);
                expect(result[0].totalActions).toBe(2);
            });

            test('summarizeDriveActivities: archivo con edit + comment refleja ambos contadores', () => {
                const raw = [
                    makeActivity('edit',    'doc1', 'Informe'),
                    makeActivity('comment', 'doc1', 'Informe'),
                    makeActivity('comment', 'doc1', 'Informe', 'application/vnd.google-apps.document', '2026-05-26T11:30:00.000Z'),
                ];

                const [entry] = summarizeDriveActivities(raw);

                expect(entry.editCount).toBe(1);
                expect(entry.commentCount).toBe(2);
                expect(entry.totalActions).toBe(3);
            });
        });

        // ------------------------------------------------------------------
        // Archivos compartidos
        // ------------------------------------------------------------------
        describe('Archivos compartidos', () => {
            test('Archivo compartido sin título: se persiste con title=null sin romper', async () => {
                // La API puede devolver title=null en archivos de terceros si el nombre
                // no es accesible en el momento de la consolidación.
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/shared1', title: null, mimeType: 'application/vnd.google-apps.document' } }],
                            actors: [CURRENT_USER],
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });
                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.upsert.mock.calls[0][0].create;
                // Sin nombre de archivo, el title queda solo con el verbo de la acción.
                expect(record.title).toBe('Editó');
                expect(record.metadata.title).toBe('Editó');
                expect(record.metadata.fileId).toBe('shared1');
            });

            test('Archivo compartido sin mimeType: fileType cae a "file"', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/shared2', title: 'Archivo externo', mimeType: null } }],
                            actors: [CURRENT_USER],
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.upsert.mock.calls[0][0].create;
                expect(record.fileType).toBe('file');
            });

            test('Actividad colaborativa donde el empleado es uno de los actores: se persiste como actividad propia', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/shared3', title: 'Colaborativo', mimeType: 'application/vnd.google-apps.document' } }],
                            actors: [
                                CURRENT_USER,
                                { user: { knownUser: { personName: 'people/user-B', isCurrentUser: false } } },
                            ],
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.upsert.mock.calls.map((c) => c[0].create);
                expect(data).toHaveLength(1);
                expect(data[0].metadata.fileId).toBe('shared3');
                expect(data[0].activityType).toBe('edit');
                expect(data[0].fileType).toBe('document');
            });

            test('enrichDriveActivitySummary: 403 en archivo compartido → conserva datos originales y deriva app del mimeType', async () => {
                const sharedSummary = [{
                    fileId: 'shared4',
                    title: 'Título original',
                    mimeType: 'application/vnd.google-apps.presentation',
                    editCount: 1, commentCount: 0, shareCount: 0, totalActions: 1,
                }];
                // 403: el archivo es de un tercero y no se puede llamar a files.get
                mockFilesGet.mockRejectedValue(Object.assign(new Error('403 Forbidden'), { code: 403 }));

                const [result] = await enrichDriveActivitySummary(sharedSummary, 'token');

                expect(result.title).toBe('Título original');
                expect(result.webViewLink).toBeNull();
                expect(result.app).toBe('Google Slides');
                expect(result.mimeType).toBe('application/vnd.google-apps.presentation');
            });

            test('enrichDriveActivitySummary: 404 en archivo compartido revocado → conserva datos originales', async () => {
                const sharedSummary = [{
                    fileId: 'revoked1',
                    title: 'Archivo revocado',
                    mimeType: 'application/vnd.google-apps.spreadsheet',
                    editCount: 2, commentCount: 0, shareCount: 0, totalActions: 2,
                }];
                mockFilesGet.mockRejectedValue(Object.assign(new Error('404 Not Found'), { code: 404 }));

                const [result] = await enrichDriveActivitySummary(sharedSummary, 'token');

                expect(result.fileId).toBe('revoked1');
                expect(result.title).toBe('Archivo revocado');
                expect(result.app).toBe('Google Sheets');
                expect(result.webViewLink).toBeNull();
            });

            test('Mezcla de archivo propio (enriquece OK) y compartido (403): cada uno se resuelve independientemente', async () => {
                const summary = [
                    { fileId: 'own1',    title: 'Mío',      mimeType: 'application/vnd.google-apps.document',     editCount: 1, commentCount: 0, shareCount: 0, totalActions: 1 },
                    { fileId: 'shared5', title: 'Compartido', mimeType: 'application/vnd.google-apps.spreadsheet', editCount: 1, commentCount: 0, shareCount: 0, totalActions: 1 },
                ];
                mockFilesGet
                    .mockResolvedValueOnce({ data: { name: 'Nombre fresco', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/own1' } })
                    .mockRejectedValueOnce(new Error('403 Forbidden'));

                const results = await enrichDriveActivitySummary(summary, 'token');

                expect(results[0].title).toBe('Nombre fresco');
                expect(results[0].webViewLink).toBe('https://docs.google.com/own1');
                expect(results[1].title).toBe('Compartido');
                expect(results[1].webViewLink).toBeNull();
                expect(results[1].app).toBe('Google Sheets');
            });
        });

        // ------------------------------------------------------------------
        // Ediciones simultáneas
        // ------------------------------------------------------------------
        describe('Ediciones simultáneas', () => {
            test('Mismo archivo editado con timestamps iguales (consolidación API): produce un solo registro', async () => {
                const ts = '2026-05-26T10:00:00.000Z';
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('edit', 'doc1', 'Simultáneo', 'application/vnd.google-apps.document', ts),
                            makeActivity('edit', 'doc1', 'Simultáneo', 'application/vnd.google-apps.document', ts),
                        ],
                    },
                });
                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                expect(prisma.dailyActivity.upsert.mock.calls).toHaveLength(1);
            });

            test('Mismo archivo, timestamps iguales: startTime = endTime - buffer (duración mínima = buffer)', async () => {
                const ts = '2026-05-26T10:00:00.000Z';
                const tsMs = new Date(ts).getTime();
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('edit', 'doc1', 'Doc', 'application/vnd.google-apps.document', ts),
                            makeActivity('edit', 'doc1', 'Doc', 'application/vnd.google-apps.document', ts),
                        ],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.upsert.mock.calls[0][0].create;
                expect(record.startTime).toEqual(new Date(tsMs));
                expect(record.endTime).toEqual(new Date(tsMs + WORK_BUFFER_MS));
            });

            test('Actividad consolidada con timeRange que ya cubre la sesión de edición simultánea: usa startTime del rango', async () => {
                const rangeStart = '2026-05-26T10:00:00.000Z';
                const rangeEnd   = '2026-05-26T10:30:00.000Z';
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/doc1', title: 'Colaborativo', mimeType: 'application/vnd.google-apps.document' } }],
                            actors: [
                                CURRENT_USER,
                                { user: { knownUser: { personName: 'people/B', isCurrentUser: false } } },
                            ],
                            timeRange: { startTime: rangeStart, endTime: rangeEnd },
                        }],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.upsert.mock.calls[0][0].create;
                expect(record.startTime).toEqual(new Date(rangeStart));
                // La API trajo endTime explícito en el rango: se usa tal cual.
                expect(record.endTime).toEqual(new Date(rangeEnd));
            });

            test('Dos archivos distintos editados al mismo timestamp: generan dos registros independientes con el mismo startTime', async () => {
                const ts = '2026-05-26T10:00:00.000Z';
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('edit', 'doc1',   'Doc A',    'application/vnd.google-apps.document',     ts),
                            makeActivity('edit', 'sheet1', 'Sheet B',  'application/vnd.google-apps.spreadsheet',  ts),
                        ],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.upsert.mock.calls.map((c) => c[0].create);
                expect(data).toHaveLength(2);
                expect(data[0].startTime).toEqual(new Date(ts));
                expect(data[1].startTime).toEqual(new Date(ts));
                const fileIds = data.map((r) => r.metadata.fileId).sort();
                expect(fileIds).toEqual(['doc1', 'sheet1']);
            });

            test('Mismo archivo: edición propia + edición simultánea de otro usuario → un solo registro que abarca ambas acciones', async () => {
                const t1 = '2026-05-26T10:00:00.000Z';
                const t2 = '2026-05-26T10:20:00.000Z';
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('edit', 'doc1', 'Colaborativo', 'application/vnd.google-apps.document', t1),
                            makeActivity('edit', 'doc1', 'Colaborativo', 'application/vnd.google-apps.document', t2),
                        ],
                    },
                });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.upsert.mock.calls.map((c) => c[0].create);
                expect(data).toHaveLength(1);
                expect(data[0].startTime).toEqual(new Date(t1));
                // Misma sesión (gap 20 min ≤ 30): endTime cae en la última acción.
                expect(data[0].endTime).toEqual(new Date(t2));
            });
        });
    });

    // ====================================================================
    // SUITE 5: enrichDriveActivitySummary — metadata fresca + app label
    // (ver también los casos de archivos compartidos en SUITE 4)
    // ====================================================================
    describe('enrichDriveActivitySummary', () => {
        const baseSummary = [
            { fileId: 'doc1', title: 'Viejo título', mimeType: 'application/vnd.google-apps.document', editCount: 2, commentCount: 1, shareCount: 0, totalActions: 3 },
            { fileId: 'sheet1', title: 'Planilla', mimeType: 'application/vnd.google-apps.spreadsheet', editCount: 1, commentCount: 0, shareCount: 1, totalActions: 2 },
        ];

        test('Devuelve array vacío si el resumen está vacío', async () => {
            const result = await enrichDriveActivitySummary([], 'token');
            expect(result).toEqual([]);
            expect(mockFilesGet).not.toHaveBeenCalled();
        });

        test('Llama a files.get en paralelo por cada archivo del resumen', async () => {
            mockFilesGet.mockResolvedValue({ data: { name: 'Doc', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/doc1' } });

            await enrichDriveActivitySummary(baseSummary, 'token');

            expect(mockFilesGet).toHaveBeenCalledTimes(2);
            expect(mockFilesGet).toHaveBeenCalledWith({ fileId: 'doc1', fields: 'name,mimeType,webViewLink', supportsAllDrives: true });
            expect(mockFilesGet).toHaveBeenCalledWith({ fileId: 'sheet1', fields: 'name,mimeType,webViewLink', supportsAllDrives: true });
        });

        test('Enriquece title con el nombre fresco de la Drive API', async () => {
            mockFilesGet
                .mockResolvedValueOnce({ data: { name: 'Informe Q2', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/doc1' } })
                .mockResolvedValueOnce({ data: { name: 'Presupuesto', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://sheets.google.com/sheet1' } });

            const result = await enrichDriveActivitySummary(baseSummary, 'token');

            expect(result[0].title).toBe('Informe Q2');
            expect(result[1].title).toBe('Presupuesto');
        });

        test('Incluye webViewLink en cada entrada enriquecida', async () => {
            mockFilesGet
                .mockResolvedValueOnce({ data: { name: 'Doc', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/doc1' } })
                .mockResolvedValueOnce({ data: { name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://sheets.google.com/sheet1' } });

            const result = await enrichDriveActivitySummary(baseSummary, 'token');

            expect(result[0].webViewLink).toBe('https://docs.google.com/doc1');
            expect(result[1].webViewLink).toBe('https://sheets.google.com/sheet1');
        });

        test('Determina app correctamente según el mimeType', async () => {
            mockFilesGet
                .mockResolvedValueOnce({ data: { name: 'Doc', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://x' } })
                .mockResolvedValueOnce({ data: { name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://x' } });

            const result = await enrichDriveActivitySummary(baseSummary, 'token');

            expect(result[0].app).toBe('Google Docs');
            expect(result[1].app).toBe('Google Sheets');
        });

        test('Devuelve app: null para mimeTypes no nativos de Workspace (PDF, imagen, etc.)', async () => {
            const pdfSummary = [
                { fileId: 'pdf1', title: 'contrato.pdf', mimeType: 'application/pdf', editCount: 1, commentCount: 0, shareCount: 0, totalActions: 1 },
            ];
            mockFilesGet.mockResolvedValue({ data: { name: 'contrato.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/pdf1' } });

            const [result] = await enrichDriveActivitySummary(pdfSummary, 'token');

            expect(result.app).toBeNull();
            expect(result.webViewLink).toBe('https://drive.google.com/pdf1');
        });

        test('Preserva conteos del resumen original en cada entrada enriquecida', async () => {
            mockFilesGet.mockResolvedValue({ data: { name: 'Doc', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://x' } });

            const result = await enrichDriveActivitySummary([baseSummary[0]], 'token');

            expect(result[0].editCount).toBe(2);
            expect(result[0].commentCount).toBe(1);
            expect(result[0].shareCount).toBe(0);
            expect(result[0].totalActions).toBe(3);
        });

        test('Si files.get falla, conserva los datos del resumen y deriva app del mimeType del resumen', async () => {
            mockFilesGet
                .mockRejectedValueOnce(new Error('403 Forbidden'))
                .mockResolvedValueOnce({ data: { name: 'Planilla OK', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://x' } });

            const result = await enrichDriveActivitySummary(baseSummary, 'token');

            // El primer archivo falla: conserva datos originales y deriva app del mimeType del resumen
            expect(result[0].fileId).toBe('doc1');
            expect(result[0].title).toBe('Viejo título');
            expect(result[0].webViewLink).toBeNull();
            expect(result[0].app).toBe('Google Docs');

            // El segundo archivo se enriquece correctamente
            expect(result[1].title).toBe('Planilla OK');
            expect(result[1].app).toBe('Google Sheets');
        });

        test('Deriva app y mimeType del resumen si la API responde OK pero sin mimeType', async () => {
            // files.get resuelve sin mimeType: se usa el del resumen para mimeType y app.
            mockFilesGet.mockResolvedValue({ data: { name: 'Doc', webViewLink: 'https://x' } });

            const [result] = await enrichDriveActivitySummary([baseSummary[0]], 'token');

            expect(result.mimeType).toBe('application/vnd.google-apps.document');
            expect(result.app).toBe('Google Docs');
        });

        test('Loguea un warn por cada archivo que no se pudo enriquecer', async () => {
            mockFilesGet.mockRejectedValue(new Error('404 Not Found'));

            await enrichDriveActivitySummary([baseSummary[0]], 'token');

            expect(logger.warn).toHaveBeenCalledWith(
                'No se pudo obtener metadata del archivo de Drive',
                expect.objectContaining({ fileId: 'doc1' }),
            );
        });

        test('Sanea el nombre fresco del archivo antes de asignarlo como title', async () => {
            mockFilesGet.mockResolvedValue({
                data: { name: `Doc\x00\x07umento${'C'.repeat(5000)}`, mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://x' },
            });

            const [result] = await enrichDriveActivitySummary([baseSummary[0]], 'token');

            // eslint-disable-next-line no-control-regex
            expect(result.title).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
            expect(result.title.length).toBeLessThanOrEqual(200);
        });
    });

    // ====================================================================
    // SUITE 6: Cobertura fuera de "Mi unidad" + atribución por actor
    //          (fix F-DRIVE-02)
    // ====================================================================
    describe('Cobertura fuera de Mi unidad y atribución por actor', () => {
        const mockUserId = 'user-uuid-123';
        const startTime  = '2026-05-26T03:00:00.000Z';
        const endTime    = '2026-05-27T03:00:00.000Z';

        // Construye una actividad con el actor del usuario actual.
        const ownActivity = (fileId, ts = '2026-05-26T10:00:00.000Z') => ({
            primaryActionDetail: { edit: {} },
            targets: [{ driveItem: { name: `items/${fileId}`, title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
            actors: [CURRENT_USER],
            timestamp: ts,
        });

        // Mock de la Activity API que solo devuelve `activity` en la query
        // principal del scope indicado (ancestorName | itemName). El resto vacío.
        const scopedActivityQuery = (matches) => ({ requestBody }) => {
            const isMain = !requestBody.filter.includes('action_detail_case');
            if (isMain && !requestBody.pageToken) {
                const hit = matches.find(
                    (m) => requestBody[m.key] === m.value,
                );
                if (hit) return Promise.resolve({ data: { activities: [hit.activity] } });
            }
            return Promise.resolve({ data: { activities: [] } });
        };

        test('CA-02: persiste actividad propia en una Unidad compartida (ancestorName)', async () => {
            mockDrivesList.mockResolvedValue({ data: { drives: [{ id: 'driveA' }] } });
            mockActivityQuery.mockImplementation(scopedActivityQuery([
                { key: 'ancestorName', value: 'items/driveA', activity: ownActivity('sd-doc') },
            ]));

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(1);
            const record = prisma.dailyActivity.upsert.mock.calls[0][0].create;
            expect(record.metadata.fileId).toBe('sd-doc');
        });

        test('CA-01: persiste actividad propia sobre un documento "Compartido conmigo" (itemName)', async () => {
            mockFilesList.mockResolvedValue({ data: { files: [{ id: 'extFile', mimeType: 'application/vnd.google-apps.document' }] } });
            mockActivityQuery.mockImplementation(scopedActivityQuery([
                { key: 'itemName', value: 'items/extFile', activity: ownActivity('extFile') },
            ]));

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(1);
            expect(prisma.dailyActivity.upsert.mock.calls[0][0].create.metadata.fileId).toBe('extFile');
        });

        test('CA-03/CA-04: descarta actividad cuyo actor no es el usuario actual', async () => {
            const otherUserActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/shared9', title: 'Ajeno', mimeType: 'application/vnd.google-apps.document' } }],
                actors: [{ user: { knownUser: { personName: 'people/otro', isCurrentUser: false } } }],
                timestamp: '2026-05-26T10:00:00.000Z',
            };
            mockActivityQuery.mockImplementation(scopedActivityQuery([
                { key: 'ancestorName', value: 'items/root', activity: otherUserActivity },
            ]));

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(0);
            expect(prisma.dailyActivity.upsert).not.toHaveBeenCalled();
        });

        test('CA-05: mismo archivo+acción+instante en Mi unidad y Unidad compartida → un solo registro (dedup entre scopes)', async () => {
            const dup = ownActivity('dup-doc', '2026-05-26T10:00:00.000Z');
            mockDrivesList.mockResolvedValue({ data: { drives: [{ id: 'driveA' }] } });
            mockActivityQuery.mockImplementation(scopedActivityQuery([
                { key: 'ancestorName', value: 'items/root', activity: dup },
                { key: 'ancestorName', value: 'items/driveA', activity: dup },
            ]));

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(1);
            expect(prisma.dailyActivity.upsert).toHaveBeenCalledTimes(1);
        });

        test('CA-06: un scope que falla no aborta; los demás se persisten', async () => {
            mockDrivesList.mockResolvedValue({ data: { drives: [{ id: 'driveBroken' }] } });
            mockActivityQuery.mockImplementation(({ requestBody }) => {
                // El scope de la unidad compartida falla; Mi unidad responde OK.
                if (requestBody.ancestorName === 'items/driveBroken') {
                    return Promise.reject(new Error('scope caído'));
                }
                const isMain = !requestBody.filter.includes('action_detail_case');
                if (isMain && requestBody.ancestorName === 'items/root') {
                    return Promise.resolve({ data: { activities: [ownActivity('mydoc')] } });
                }
                return Promise.resolve({ data: { activities: [] } });
            });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.created).toBe(1);
            expect(prisma.dailyActivity.upsert.mock.calls[0][0].create.metadata.fileId).toBe('mydoc');
            expect(logger.warn).toHaveBeenCalledWith(
                'Scope de Drive omitido por error en la consulta',
                expect.objectContaining({ message: 'scope caído' }),
            );
        });

        test('CA-08: sin unidades ni compartidos → solo se consulta items/root', async () => {
            mockActivityQuery.mockResolvedValue({ data: { activities: [] } });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            // Todas las queries de actividad apuntan a items/root (un solo scope).
            const scopesConsultados = new Set(
                mockActivityQuery.mock.calls.map((c) => c[0].requestBody.ancestorName),
            );
            expect([...scopesConsultados]).toEqual(['items/root']);
        });

        describe('isCurrentUserActivity', () => {
            test('true cuando algún actor es el usuario actual', () => {
                expect(isCurrentUserActivity({ actors: [CURRENT_USER] })).toBe(true);
                expect(isCurrentUserActivity({
                    actors: [{ user: { knownUser: { isCurrentUser: false } } }, CURRENT_USER],
                })).toBe(true);
            });

            test('false para otros usuarios, sistema, anónimos o sin actor', () => {
                expect(isCurrentUserActivity({ actors: [{ user: { knownUser: { isCurrentUser: false } } }] })).toBe(false);
                expect(isCurrentUserActivity({ actors: [{ system: {} }] })).toBe(false);
                expect(isCurrentUserActivity({ actors: [] })).toBe(false);
                expect(isCurrentUserActivity({})).toBe(false);
            });
        });
    });
});
