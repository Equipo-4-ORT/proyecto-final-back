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
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
}));
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
}));

describe('Drive Activity Service', () => {
    let mockActivityQuery;
    let mockFilesGet;

    beforeEach(() => {
        jest.clearAllMocks();

        getAuthenticatedGoogleClient.mockReturnValue({});

        mockActivityQuery = jest.fn();
        google.driveactivity.mockReturnValue({
            activity: { query: mockActivityQuery },
        });

        mockFilesGet = jest.fn();
        google.drive.mockReturnValue({
            files: { get: mockFilesGet },
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
            expect(mockActivityQuery).toHaveBeenCalledTimes(1);
        });

        test('Devuelve las actividades de una sola página correctamente', async () => {
            const mockActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [mockActivity] } });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            expect(result).toHaveLength(1);
            expect(mockActivityQuery).toHaveBeenCalledTimes(1);
        });

        test('Maneja la paginación acumulando todas las páginas', async () => {
            const page1 = { primaryActionDetail: { edit: {} }, timestamp: '2026-05-26T10:00:00Z' };
            const page2 = { primaryActionDetail: { create: {} }, timestamp: '2026-05-26T14:00:00Z' };

            mockActivityQuery
                .mockResolvedValueOnce({ data: { activities: [page1], nextPageToken: 'token-pagina-2' } })
                .mockResolvedValueOnce({ data: { activities: [page2] } });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            expect(result).toHaveLength(2);
            expect(mockActivityQuery).toHaveBeenCalledTimes(2);
            expect(mockActivityQuery.mock.calls[1][0].requestBody.pageToken).toBe('token-pagina-2');
        });

        test('Corta la paginación al alcanzar el tope de páginas y loguea un warn', async () => {
            // nextPageToken nunca se vacía: simula el bug de token cíclico de la API.
            mockActivityQuery.mockResolvedValue({
                data: { activities: [], nextPageToken: 'loop' },
            });

            const result = await getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z');

            // No entra en loop infinito: corta en MAX_PAGES (100).
            expect(result).toEqual([]);
            expect(mockActivityQuery).toHaveBeenCalledTimes(100);
            expect(logger.warn).toHaveBeenCalledWith(
                'Tope de páginas de Drive Activity alcanzado',
                expect.objectContaining({ pages: 100 }),
            );
        });

        test('Lanza error si la API falla', async () => {
            mockActivityQuery.mockRejectedValue(new Error('Google API caída'));

            await expect(
                getDriveActivitiesForDay('token', '2026-05-26T00:00:00Z', '2026-05-27T00:00:00Z')
            ).rejects.toThrow('Error al obtener actividades de Drive');
        });
    });

    // ====================================================================
    // SUITE 2: buildWorkEstimates — lógica de estimación de duración pura
    // ====================================================================
    describe('buildWorkEstimates', () => {
        const USER_ID = 'user-uuid-123';
        const WINDOW_DATE = '2026-05-26';

        test('acción única: endTime = timestamp + buffer de 5 min', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: 'application/vnd.google-apps.document', title: 'Doc', timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.startTime).toEqual(new Date(tsMs));
            expect(record.endTime).toEqual(new Date(tsMs + WORK_BUFFER_MS));
        });

        test('varias acciones: startTime = primera, endTime = última + buffer', () => {
            const t1 = new Date('2026-05-26T10:00:00.000Z').getTime();
            const t2 = new Date('2026-05-26T10:30:00.000Z').getTime();
            const t3 = new Date('2026-05-26T11:00:00.000Z').getTime();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: null, title: null, timestampsMs: [t2, t1, t3] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.startTime).toEqual(new Date(t1));
            expect(record.endTime).toEqual(new Date(t3 + WORK_BUFFER_MS));
        });

        test('respeta el tope de 2 h aunque las acciones estén muy separadas', () => {
            const t1 = new Date('2026-05-26T09:00:00.000Z').getTime();
            const t2 = new Date('2026-05-26T14:00:00.000Z').getTime(); // 5 h después
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: null, title: null, timestampsMs: [t1, t2] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            const durationMs = record.endTime.getTime() - record.startTime.getTime();
            expect(durationMs).toBe(MAX_WORK_DURATION_MS);
        });

        test('genera un externalId estable del tipo file_<fileId>_<YYYY-MM-DD>', () => {
            const tsMs = new Date('2026-05-26T10:00:00.000Z').getTime();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: null, title: null, timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.externalId).toBe('file_doc1_2026-05-26');
        });

        test('activityType se deriva del mimeType, source siempre es "drive"', () => {
            const tsMs = Date.now();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: 'application/vnd.google-apps.document', title: null, timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.activityType).toBe('document');
            expect(record.source).toBe('drive');
        });

        test('activityType es "file" para mimeTypes no nativos de Workspace (PDF, imagen, etc.)', () => {
            const tsMs = Date.now();
            const byFile = new Map([
                ['pdf1', { fileId: 'pdf1', mimeType: 'application/pdf', title: null, timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.activityType).toBe('file');
        });

        test('activityType es "file" cuando mimeType es null', () => {
            const tsMs = Date.now();
            const byFile = new Map([
                ['file1', { fileId: 'file1', mimeType: null, title: null, timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.activityType).toBe('file');
        });

        test('cubre todos los tipos nativos de Workspace: spreadsheet, presentation, form, drawing, script', () => {
            const cases = [
                ['application/vnd.google-apps.spreadsheet',  'spreadsheet'],
                ['application/vnd.google-apps.presentation', 'presentation'],
                ['application/vnd.google-apps.form',         'form'],
                ['application/vnd.google-apps.drawing',      'drawing'],
                ['application/vnd.google-apps.script',       'script'],
            ];
            const tsMs = Date.now();

            cases.forEach(([mimeType, expectedType]) => {
                const byFile = new Map([
                    ['f1', { fileId: 'f1', mimeType, title: null, timestampsMs: [tsMs] }],
                ]);
                const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);
                expect(record.activityType).toBe(expectedType);
            });
        });

        test('genera un registro por archivo (no uno por acción)', () => {
            const t1 = Date.now();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: null, title: null, timestampsMs: [t1, t1 + 1000] }],
                ['doc2', { fileId: 'doc2', mimeType: null, title: null, timestampsMs: [t1 + 2000] }],
            ]);

            const records = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(records).toHaveLength(2);
        });

        test('incluye fileId, mimeType y title en metadata', () => {
            const tsMs = Date.now();
            const mimeType = 'application/vnd.google-apps.spreadsheet';
            const byFile = new Map([
                ['sheet1', { fileId: 'sheet1', mimeType, title: 'Mi hoja', timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.metadata).toEqual({ title: 'Mi hoja', fileId: 'sheet1', mimeType });
        });

        test('puebla el campo title de primer nivel además de metadata', () => {
            const tsMs = Date.now();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: 'application/vnd.google-apps.document', title: 'Mi informe', timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.title).toBe('Mi informe');
        });

        test('title de primer nivel es null cuando el archivo no tiene título', () => {
            const tsMs = Date.now();
            const byFile = new Map([
                ['doc1', { fileId: 'doc1', mimeType: 'application/vnd.google-apps.document', title: null, timestampsMs: [tsMs] }],
            ]);

            const [record] = buildWorkEstimates(byFile, USER_ID, WINDOW_DATE);

            expect(record.title).toBeNull();
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

        test('Filtra acciones no relevantes (rename, move, delete, comment)', async () => {
            const irrelevantActivities = ['rename', 'move', 'delete', 'comment'].map(type => ({
                primaryActionDetail: { [type]: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            }));
            mockActivityQuery.mockResolvedValue({ data: { activities: irrelevantActivities } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.count).toBe(0);
            expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
        });

        test('Filtra archivos de tipo carpeta y acceso directo', async () => {
            const excluded = [
                { mimeType: 'application/vnd.google-apps.folder', name: 'items/folder1', title: 'Carpeta' },
                { mimeType: 'application/vnd.google-apps.shortcut', name: 'items/sc1', title: 'Acceso directo' },
            ].map(driveItem => ({
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem }],
                timestamp: '2026-05-26T10:00:00Z',
            }));
            mockActivityQuery.mockResolvedValue({ data: { activities: excluded } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.count).toBe(0);
            expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
        });

        // ── Agrupación por archivo (comportamiento nuevo) ─────────────────────

        test('Un archivo con una acción: persiste UN registro con activityType derivado del mimeType', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Mi Documento', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.count).toBe(1);
            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data).toHaveLength(1);
            expect(data[0]).toMatchObject({ source: 'drive', activityType: 'document', userId: mockUserId });
            expect(data[0].title).toBe('Mi Documento');
            expect(data[0].metadata).toMatchObject({ title: 'Mi Documento', fileId: 'doc1' });
        });

        test('Acción "create" en spreadsheet: activityType="spreadsheet"', async () => {
            const activity = {
                primaryActionDetail: { create: { new: {} } },
                targets: [{ driveItem: { name: 'items/sheet1', title: 'Nueva Planilla', mimeType: 'application/vnd.google-apps.spreadsheet' } }],
                timestamp: '2026-05-26T14:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);
            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data[0].activityType).toBe('spreadsheet');
        });

        test('Archivo sin mimeType nativo (PDF): activityType="file"', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/pdf1', title: 'contrato.pdf', mimeType: 'application/pdf' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);
            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data[0].activityType).toBe('file');
        });

        test('Dos archivos distintos → dos registros (uno por archivo)', async () => {
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: '2026-05-26T10:00:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/sheet1', title: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' } }], timestamp: '2026-05-26T11:00:00Z' },
                    ],
                },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 2 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data).toHaveLength(2);
            const fileIds = data.map((r) => r.metadata.fileId).sort();
            expect(fileIds).toEqual(['doc1', 'sheet1']);
        });

        test('Un archivo con varias acciones → UN solo registro (no uno por acción)', async () => {
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: '2026-05-26T10:00:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: '2026-05-26T10:15:00Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: '2026-05-26T10:45:00Z' },
                    ],
                },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data).toHaveLength(1);
        });

        test('startTime = primera acción, endTime = última + 5 min', async () => {
            const t1 = '2026-05-26T10:00:00.000Z';
            const t3 = '2026-05-26T10:45:00.000Z';
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: t1 },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: '2026-05-26T10:20:00.000Z' },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: t3 },
                    ],
                },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
            expect(record.startTime).toEqual(new Date(t1));
            expect(record.endTime).toEqual(new Date(new Date(t3).getTime() + WORK_BUFFER_MS));
        });

        test('Acciones muy separadas: endTime no supera el tope de 2 h', async () => {
            const t1 = '2026-05-26T09:00:00.000Z';
            const t2 = '2026-05-26T14:00:00.000Z'; // 5 h después
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: t1 },
                        { primaryActionDetail: { edit: {} }, targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }], timestamp: t2 },
                    ],
                },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
            const durationMs = record.endTime.getTime() - record.startTime.getTime();
            expect(durationMs).toBe(MAX_WORK_DURATION_MS);
        });

        test('Actividad con timeRange: usa startTime del rango como timestamp de la acción', async () => {
            const rangeStart = '2026-05-26T10:00:00.000Z';
            mockActivityQuery.mockResolvedValue({
                data: {
                    activities: [{
                        primaryActionDetail: { edit: {} },
                        targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                        timeRange: { startTime: rangeStart, endTime: '2026-05-26T10:20:00.000Z' },
                    }],
                },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
            // Con una sola acción: startTime = rangeStart, endTime = rangeStart + buffer
            expect(record.startTime).toEqual(new Date(rangeStart));
            expect(record.endTime).toEqual(new Date(new Date(rangeStart).getTime() + WORK_BUFFER_MS));
        });

        test('Construye externalId estable file_<fileId>_<YYYY-MM-DD>', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            // windowDate se toma del inicio de la ventana: 2026-05-26
            expect(data[0].externalId).toBe('file_doc1_2026-05-26');
        });

        test('Llama createMany con skipDuplicates: true', async () => {
            mockActivityQuery.mockResolvedValue({
                data: { activities: [{
                    primaryActionDetail: { edit: {} },
                    targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                    timestamp: '2026-05-26T10:00:00Z',
                }] },
            });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(prisma.dailyActivity.createMany).toHaveBeenCalledWith(
                expect.objectContaining({ skipDuplicates: true })
            );
        });

        test('sanea + trunca el title del archivo (control chars y longitud) antes de persistir', async () => {
            const evilActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: `Doc\x00\x07umento${'C'.repeat(5000)}`, mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [evilActivity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const saved = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
            // eslint-disable-next-line no-control-regex
            expect(saved.metadata.title).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F]/);
            expect(saved.metadata.title.length).toBeLessThanOrEqual(200);
            expect(saved.metadata.title.startsWith('Documento')).toBe(true);
        });

        test('Devuelve count 0 y mensaje cuando no hay actividades relevantes', async () => {
            mockActivityQuery.mockResolvedValue({ data: { activities: [] } });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result).toEqual({
                count: 0,
                message: 'No se encontraron actividades relevantes de Drive para guardar',
            });
            expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
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

        test('Ignora acciones fuera de SUMMARY_ACTIONS (rename, move, delete)', () => {
            const activities = ['rename', 'move', 'delete'].map((t) => docActivity(t));

            expect(summarizeDriveActivities(activities)).toEqual([]);
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
            timestamp: ts,
        });

        // ------------------------------------------------------------------
        // Solo comentarios
        // ------------------------------------------------------------------
        describe('Solo comentarios', () => {
            test('Un archivo con solo comentarios: persistDriveActivities no guarda nada', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('comment', 'doc1', 'Informe'),
                            makeActivity('comment', 'doc1', 'Informe', 'application/vnd.google-apps.document', '2026-05-26T11:00:00.000Z'),
                        ],
                    },
                });

                const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                expect(result.count).toBe(0);
                expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
            });

            test('Varios archivos con solo comentarios: ninguno se persiste', async () => {
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

                expect(result.count).toBe(0);
                expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
            });

            test('Comentarios mezclados con edits: solo se persiste el archivo que tuvo edits', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [
                            makeActivity('comment', 'doc1', 'Solo comentado'),
                            makeActivity('edit',    'doc2', 'Editado',          'application/vnd.google-apps.spreadsheet'),
                            makeActivity('comment', 'doc2', 'Editado y comentado', 'application/vnd.google-apps.spreadsheet'),
                        ],
                    },
                });
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                expect(result.count).toBe(1);
                const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
                expect(data).toHaveLength(1);
                expect(data[0].metadata.fileId).toBe('doc2');
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
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
                expect(record.title).toBeNull();
                expect(record.metadata.title).toBeNull();
                expect(record.metadata.fileId).toBe('shared1');
            });

            test('Archivo compartido sin mimeType: activityType cae a "file"', async () => {
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/shared2', title: 'Archivo externo', mimeType: null } }],
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
                expect(record.activityType).toBe('file');
            });

            test('Actividad con múltiples actores (archivo compartido editado en conjunto): se procesa como una actividad normal', async () => {
                // La Drive Activity API consolida ediciones de varios usuarios en una
                // actividad con un array actors[]. El servicio extrae el target, no los
                // actores, por lo que la lógica es idéntica a una edición individual.
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/shared3', title: 'Colaborativo', mimeType: 'application/vnd.google-apps.document' } }],
                            actors: [
                                { user: { knownUser: { personName: 'people/user-A' } } },
                                { user: { knownUser: { personName: 'people/user-B' } } },
                            ],
                            timestamp: '2026-05-26T10:00:00.000Z',
                        }],
                    },
                });
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
                expect(data).toHaveLength(1);
                expect(data[0].metadata.fileId).toBe('shared3');
                expect(data[0].activityType).toBe('document');
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
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
                expect(data).toHaveLength(1);
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
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
                expect(record.startTime).toEqual(new Date(tsMs));
                expect(record.endTime).toEqual(new Date(tsMs + WORK_BUFFER_MS));
            });

            test('Actividad consolidada con timeRange que ya cubre la sesión de edición simultánea: usa startTime del rango', async () => {
                // La API devuelve un timeRange cuando consolida ediciones continuas
                // de varios actores en una ventana de tiempo.
                const rangeStart = '2026-05-26T10:00:00.000Z';
                const rangeEnd   = '2026-05-26T10:30:00.000Z';
                mockActivityQuery.mockResolvedValue({
                    data: {
                        activities: [{
                            primaryActionDetail: { edit: {} },
                            targets: [{ driveItem: { name: 'items/doc1', title: 'Colaborativo', mimeType: 'application/vnd.google-apps.document' } }],
                            actors: [
                                { user: { knownUser: { personName: 'people/A' } } },
                                { user: { knownUser: { personName: 'people/B' } } },
                            ],
                            timeRange: { startTime: rangeStart, endTime: rangeEnd },
                        }],
                    },
                });
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const record = prisma.dailyActivity.createMany.mock.calls[0][0].data[0];
                // Una sola acción (el timeRange): startTime = rangeStart, endTime = rangeStart + buffer
                expect(record.startTime).toEqual(new Date(rangeStart));
                expect(record.endTime).toEqual(new Date(new Date(rangeStart).getTime() + WORK_BUFFER_MS));
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
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 2 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
                expect(data).toHaveLength(2);
                // Ambos arrancaron al mismo tiempo
                expect(data[0].startTime).toEqual(new Date(ts));
                expect(data[1].startTime).toEqual(new Date(ts));
                // Pero son registros distintos
                const fileIds = data.map((r) => r.metadata.fileId).sort();
                expect(fileIds).toEqual(['doc1', 'sheet1']);
            });

            test('Mismo archivo: edición propia + edición simultánea de otro usuario → un solo registro que abarca ambas acciones', async () => {
                // El usuario edita a las 10:00 y otro actor edita el mismo archivo a las
                // 10:20. La API puede devolver dos actividades separadas (una por actor)
                // o una consolidada. En cualquier caso se agrupan bajo el mismo fileId.
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
                prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

                await persistDriveActivities(mockUserId, 'token', startTime, endTime);

                const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
                expect(data).toHaveLength(1);
                expect(data[0].startTime).toEqual(new Date(t1));
                expect(data[0].endTime).toEqual(new Date(new Date(t2).getTime() + WORK_BUFFER_MS));
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
});
