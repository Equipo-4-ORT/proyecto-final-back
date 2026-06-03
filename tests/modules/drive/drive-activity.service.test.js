process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';

const { google } = require('googleapis');
const {
    getDriveActivitiesForDay,
    persistDriveActivities,
    summarizeDriveActivities,
    enrichDriveActivitySummary,
    InvalidWindowError,
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
    // SUITE 2: persistDriveActivities — ventana, filtros, mapeo y persistencia
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

        test('Guarda actividades de edit y create con los campos correctamente mapeados', async () => {
            const editActivity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Mi Documento', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            const createActivity = {
                primaryActionDetail: { create: { new: {} } },
                targets: [{ driveItem: { name: 'items/sheet1', title: 'Nueva Planilla', mimeType: 'application/vnd.google-apps.spreadsheet' } }],
                timestamp: '2026-05-26T14:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [editActivity, createActivity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 2 });

            const result = await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            expect(result.count).toBe(2);
            expect(prisma.dailyActivity.createMany).toHaveBeenCalledWith(
                expect.objectContaining({ skipDuplicates: true })
            );

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data).toHaveLength(2);
            expect(data[0]).toMatchObject({ source: 'drive', activityType: 'edit', userId: mockUserId });
            expect(data[0].metadata).toMatchObject({ title: 'Mi Documento', fileId: 'doc1' });
            expect(data[1]).toMatchObject({ source: 'drive', activityType: 'create' });
        });

        test('sanea + trunca el title del archivo (control chars y longitud) antes de persistir', async () => {
            // El nombre del archivo puede venir de un archivo compartido por un tercero: input no confiable.
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

        test('Usa timeRange para startTime y endTime cuando está disponible', async () => {
            const activityWithRange = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                timeRange: { startTime: '2026-05-26T10:00:00Z', endTime: '2026-05-26T10:45:00Z' },
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activityWithRange] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data[0].startTime).toEqual(new Date('2026-05-26T10:00:00Z'));
            expect(data[0].endTime).toEqual(new Date('2026-05-26T10:45:00Z'));
        });

        test('Usa el mismo timestamp para startTime y endTime cuando no hay timeRange', async () => {
            const activityWithTimestamp = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T11:30:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activityWithTimestamp] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data[0].startTime).toEqual(new Date('2026-05-26T11:30:00Z'));
            expect(data[0].endTime).toEqual(new Date('2026-05-26T11:30:00Z'));
        });

        test('Construye externalId sintético para deduplicación', async () => {
            const activity = {
                primaryActionDetail: { edit: {} },
                targets: [{ driveItem: { name: 'items/doc1', title: 'Doc', mimeType: 'application/vnd.google-apps.document' } }],
                timestamp: '2026-05-26T10:00:00Z',
            };
            mockActivityQuery.mockResolvedValue({ data: { activities: [activity] } });
            prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

            await persistDriveActivities(mockUserId, 'token', startTime, endTime);

            const data = prisma.dailyActivity.createMany.mock.calls[0][0].data;
            expect(data[0].externalId).toBe('edit_doc1_2026-05-26T10:00:00Z');
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
    // SUITE 4: enrichDriveActivitySummary — metadata fresca + app label
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
            expect(mockFilesGet).toHaveBeenCalledWith({ fileId: 'doc1', fields: 'id,name,mimeType,webViewLink' });
            expect(mockFilesGet).toHaveBeenCalledWith({ fileId: 'sheet1', fields: 'id,name,mimeType,webViewLink' });
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

        test('Si files.get falla para un archivo, conserva los datos del resumen y app: null', async () => {
            mockFilesGet
                .mockRejectedValueOnce(new Error('403 Forbidden'))
                .mockResolvedValueOnce({ data: { name: 'Planilla OK', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'https://x' } });

            const result = await enrichDriveActivitySummary(baseSummary, 'token');

            // El primer archivo falla: conserva datos originales
            expect(result[0].fileId).toBe('doc1');
            expect(result[0].title).toBe('Viejo título');
            expect(result[0].webViewLink).toBeNull();
            expect(result[0].app).toBeNull();

            // El segundo archivo se enriquece correctamente
            expect(result[1].title).toBe('Planilla OK');
            expect(result[1].app).toBe('Google Sheets');
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
