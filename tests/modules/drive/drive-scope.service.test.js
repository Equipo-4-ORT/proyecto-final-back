process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const { google } = require('googleapis');
const {
    listSharedDriveScopes,
    listSharedWithMeScopes,
    buildDriveScopes,
    MAX_SHARED_ITEMS,
} = require('../../../src/modules/drive/drive-scope.service');
const { getAuthenticatedGoogleClient } = require('../../../src/modules/google/google.service');
const logger = require('../../../src/shared/utils/logger');

jest.mock('googleapis', () => ({
    google: { drive: jest.fn() },
}));
jest.mock('../../../src/modules/google/google.service');
jest.mock('../../../src/shared/utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));

describe('Drive Scope Service', () => {
    let mockDrivesList;
    let mockFilesList;

    beforeEach(() => {
        jest.clearAllMocks();
        getAuthenticatedGoogleClient.mockReturnValue({});

        mockDrivesList = jest.fn();
        mockFilesList = jest.fn();
        google.drive.mockReturnValue({
            drives: { list: mockDrivesList },
            files: { list: mockFilesList },
        });
    });

    // ====================================================================
    // listSharedDriveScopes — unidades compartidas → ancestorName
    // ====================================================================
    describe('listSharedDriveScopes', () => {
        test('Devuelve un scope ancestorName por cada unidad compartida', async () => {
            mockDrivesList.mockResolvedValue({ data: { drives: [{ id: 'drive-A' }, { id: 'drive-B' }] } });

            const scopes = await listSharedDriveScopes('token');

            expect(scopes).toEqual([
                { ancestorName: 'items/drive-A' },
                { ancestorName: 'items/drive-B' },
            ]);
        });

        test('Acumula todas las páginas de drives.list', async () => {
            mockDrivesList
                .mockResolvedValueOnce({ data: { drives: [{ id: 'd1' }], nextPageToken: 'p2' } })
                .mockResolvedValueOnce({ data: { drives: [{ id: 'd2' }] } });

            const scopes = await listSharedDriveScopes('token');

            expect(scopes).toEqual([{ ancestorName: 'items/d1' }, { ancestorName: 'items/d2' }]);
            const tokenedCall = mockDrivesList.mock.calls.find((c) => c[0].pageToken === 'p2');
            expect(tokenedCall).toBeDefined();
        });

        test('Devuelve [] y loguea warn si drives.list falla (tolerancia a fallo)', async () => {
            mockDrivesList.mockRejectedValue(new Error('Drive API caída'));

            const scopes = await listSharedDriveScopes('token');

            expect(scopes).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(
                'No se pudieron enumerar las unidades compartidas de Drive',
                expect.objectContaining({ message: 'Drive API caída' }),
            );
        });

        test('Devuelve [] cuando el usuario no es miembro de ninguna unidad compartida', async () => {
            mockDrivesList.mockResolvedValue({ data: {} });

            expect(await listSharedDriveScopes('token')).toEqual([]);
        });
    });

    // ====================================================================
    // listSharedWithMeScopes — "Compartido conmigo" → itemName
    // ====================================================================
    describe('listSharedWithMeScopes', () => {
        test('Devuelve un scope itemName por cada archivo compartido', async () => {
            mockFilesList.mockResolvedValue({
                data: { files: [{ id: 'f1', mimeType: 'application/vnd.google-apps.document' }, { id: 'f2', mimeType: 'application/pdf' }] },
            });

            const scopes = await listSharedWithMeScopes('token');

            expect(scopes).toEqual([{ itemName: 'items/f1' }, { itemName: 'items/f2' }]);
        });

        test('Consulta con sharedWithMe = true e incluye archivos de todas las unidades', async () => {
            mockFilesList.mockResolvedValue({ data: { files: [] } });

            await listSharedWithMeScopes('token');

            expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
                q: 'sharedWithMe = true and trashed = false',
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            }));
        });

        test('Excluye carpetas y accesos directos de la enumeración', async () => {
            mockFilesList.mockResolvedValue({
                data: {
                    files: [
                        { id: 'folder1', mimeType: 'application/vnd.google-apps.folder' },
                        { id: 'sc1', mimeType: 'application/vnd.google-apps.shortcut' },
                        { id: 'doc1', mimeType: 'application/vnd.google-apps.document' },
                    ],
                },
            });

            const scopes = await listSharedWithMeScopes('token');

            expect(scopes).toEqual([{ itemName: 'items/doc1' }]);
        });

        test('Acumula todas las páginas de files.list', async () => {
            mockFilesList
                .mockResolvedValueOnce({ data: { files: [{ id: 'f1', mimeType: 'application/pdf' }], nextPageToken: 'p2' } })
                .mockResolvedValueOnce({ data: { files: [{ id: 'f2', mimeType: 'application/pdf' }] } });

            const scopes = await listSharedWithMeScopes('token');

            expect(scopes).toEqual([{ itemName: 'items/f1' }, { itemName: 'items/f2' }]);
        });

        test('Aplica el tope MAX_SHARED_ITEMS y loguea warn', async () => {
            const files = Array.from({ length: MAX_SHARED_ITEMS + 50 }, (_, i) => ({ id: `f${i}`, mimeType: 'application/pdf' }));
            mockFilesList.mockResolvedValue({ data: { files } });

            const scopes = await listSharedWithMeScopes('token');

            expect(scopes).toHaveLength(MAX_SHARED_ITEMS);
            expect(logger.warn).toHaveBeenCalledWith(
                'Tope de archivos "Compartido conmigo" alcanzado',
                expect.objectContaining({ max: MAX_SHARED_ITEMS }),
            );
        });

        test('Devuelve [] y loguea warn si files.list falla', async () => {
            mockFilesList.mockRejectedValue(new Error('Drive API caída'));

            const scopes = await listSharedWithMeScopes('token');

            expect(scopes).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(
                'No se pudieron enumerar los archivos "Compartido conmigo" de Drive',
                expect.objectContaining({ message: 'Drive API caída' }),
            );
        });
    });

    // ====================================================================
    // buildDriveScopes — combinación de las tres ubicaciones
    // ====================================================================
    describe('buildDriveScopes', () => {
        test('Combina Mi unidad (items/root) + unidades compartidas + Compartido conmigo', async () => {
            mockDrivesList.mockResolvedValue({ data: { drives: [{ id: 'drive-A' }] } });
            mockFilesList.mockResolvedValue({ data: { files: [{ id: 'f1', mimeType: 'application/pdf' }] } });

            const scopes = await buildDriveScopes('token');

            expect(scopes).toEqual([
                { ancestorName: 'items/root' },
                { ancestorName: 'items/drive-A' },
                { itemName: 'items/f1' },
            ]);
        });

        test('Siempre incluye items/root aunque no haya unidades ni archivos compartidos', async () => {
            mockDrivesList.mockResolvedValue({ data: { drives: [] } });
            mockFilesList.mockResolvedValue({ data: { files: [] } });

            const scopes = await buildDriveScopes('token');

            expect(scopes).toEqual([{ ancestorName: 'items/root' }]);
        });

        test('Si una enumeración falla, igual devuelve items/root + la otra ubicación', async () => {
            mockDrivesList.mockRejectedValue(new Error('drives caído'));
            mockFilesList.mockResolvedValue({ data: { files: [{ id: 'f1', mimeType: 'application/pdf' }] } });

            const scopes = await buildDriveScopes('token');

            expect(scopes).toEqual([{ ancestorName: 'items/root' }, { itemName: 'items/f1' }]);
        });
    });
});
