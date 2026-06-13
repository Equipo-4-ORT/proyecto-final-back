process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const { google } = require('googleapis');
const { createReportSheet, buildSheetValues } = require('../../../src/modules/reports/reports.sheet');
const { getAuthenticatedGoogleClient } = require('../../../src/modules/google/google.service');
const { getDecryptedRefreshToken } = require('../../../src/shared/utils/refreshToken');
const { looksLikeGoogleAuthError, markGoogleReconnect } = require('../../../src/shared/utils/googleAuthError');

jest.mock('googleapis', () => ({
    google: { sheets: jest.fn() },
}));
jest.mock('../../../src/modules/google/google.service');
jest.mock('../../../src/shared/utils/refreshToken');
jest.mock('../../../src/shared/utils/googleAuthError', () => ({
    looksLikeGoogleAuthError: jest.fn(() => false),
    markGoogleReconnect: jest.fn(),
}));
jest.mock('../../../src/shared/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const aiOutput = {
    daySummary: 'Día productivo',
    totalHours: 2,
    rows: [
        {
            date: '2026-05-19',
            startTime: '09:00',
            endTime: '11:00',
            duration: 120,
            app: 'Jira',
            activityType: 'transition',
            title: 'PROJ-123',
            summary: 'Trabajo sobre PROJ-123',
        },
    ],
};

const user = { id: 'user-123' };
const report = { id: 'report-1', reportDate: new Date('2026-05-19T00:00:00.000Z') };

describe('buildSheetValues', () => {
    test('arma encabezado, total y la tabla con las filas en orden', () => {
        const values = buildSheetValues(aiOutput);

        expect(values[0]).toEqual(['Resumen del día', 'Día productivo']);
        expect(values[1]).toEqual(['Total de horas', 2]);
        expect(values[3]).toEqual(['Fecha', 'Inicio', 'Fin', 'Duración (min)', 'App', 'Tipo', 'Título', 'Resumen']);
        expect(values[4]).toEqual(['2026-05-19', '09:00', '11:00', 120, 'Jira', 'transition', 'PROJ-123', 'Trabajo sobre PROJ-123']);
    });

    test('tolera un output vacío sin romper', () => {
        const values = buildSheetValues({});
        expect(values[0]).toEqual(['Resumen del día', '']);
        expect(values[1]).toEqual(['Total de horas', 0]);
    });
});

describe('createReportSheet', () => {
    let mockCreate;
    let mockValuesUpdate;

    beforeEach(() => {
        jest.clearAllMocks();
        getDecryptedRefreshToken.mockResolvedValue('plain-token');
        getAuthenticatedGoogleClient.mockReturnValue({});

        mockCreate = jest.fn().mockResolvedValue({
            data: { spreadsheetId: 'sheet-abc', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-abc/edit' },
        });
        mockValuesUpdate = jest.fn().mockResolvedValue({});
        google.sheets.mockReturnValue({
            spreadsheets: { create: mockCreate, values: { update: mockValuesUpdate } },
        });
    });

    test('crea el Sheet (título = fecha) y escribe con USER_ENTERED; devuelve la URL', async () => {
        const url = await createReportSheet(user, report, aiOutput);

        expect(mockCreate).toHaveBeenCalledWith({
            requestBody: { properties: { title: '2026-05-19' } },
        });
        expect(mockValuesUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                spreadsheetId: 'sheet-abc',
                valueInputOption: 'USER_ENTERED',
            }),
        );
        expect(url).toBe('https://docs.google.com/spreadsheets/d/sheet-abc/edit');
    });

    test('sin refresh token de Google: devuelve null y no llama a la API', async () => {
        getDecryptedRefreshToken.mockResolvedValue(null);

        const url = await createReportSheet(user, report, aiOutput);

        expect(url).toBeNull();
        expect(google.sheets).not.toHaveBeenCalled();
    });

    test('ante fallo de la API: devuelve null (best-effort, no propaga)', async () => {
        mockCreate.mockRejectedValue(new Error('Sheets 500'));

        const url = await createReportSheet(user, report, aiOutput);

        expect(url).toBeNull();
    });

    test('si el error es de auth de Google: marca reconexión', async () => {
        mockCreate.mockRejectedValue(new Error('invalid_grant'));
        looksLikeGoogleAuthError.mockReturnValue(true);

        const url = await createReportSheet(user, report, aiOutput);

        expect(url).toBeNull();
        expect(markGoogleReconnect).toHaveBeenCalledWith('user-123');
    });
});
