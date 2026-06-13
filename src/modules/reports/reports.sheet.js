/**
 * Creación del Google Sheet del reporte diario en el Drive del empleado.
 * Ver SPEC-TEC reporte-excel-drive.
 *
 * Diseño:
 *  - Best-effort: nunca lanza. Devuelve la URL del Sheet o `null` si no se pudo
 *    crear (sin token, token revocado, Sheets caída). El reporte ya persistido
 *    sigue siendo válido (RN-06).
 *  - Usa el scope `spreadsheets` ya otorgado; el Sheet cae en la raíz de "Mi unidad".
 *  - Escribe los valores con `valueInputOption: USER_ENTERED`: los strings que el
 *    adapter de IA ya escapó con apóstrofo (anti formula injection) se interpretan
 *    como texto y el apóstrofo no se muestra. `totalHours`/`duration` quedan como
 *    números reales.
 */

const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const { getDecryptedRefreshToken } = require('../../shared/utils/refreshToken');
const { looksLikeGoogleAuthError, markGoogleReconnect } = require('../../shared/utils/googleAuthError');
const logger = require('../../shared/utils/logger');

// Encabezados de la tabla de actividades. El orden define el de las columnas.
const TABLE_HEADERS = ['Fecha', 'Inicio', 'Fin', 'Duración (min)', 'App', 'Tipo', 'Título', 'Resumen'];

/**
 * Arma la matriz de valores (filas x columnas) del Sheet a partir del output de la IA.
 * @param {import('../ai/ai.output.types').AIModuleOutput} aiOutput
 * @returns {Array<Array<string|number>>}
 */
const buildSheetValues = (aiOutput) => {
    const { daySummary = '', rows = [], totalHours = 0 } = aiOutput || {};

    const values = [
        ['Resumen del día', daySummary],
        ['Total de horas', totalHours],
        [],
        TABLE_HEADERS,
    ];

    for (const row of rows) {
        values.push([
            row.date ?? '',
            row.startTime ?? '',
            row.endTime ?? '',
            row.duration ?? '',
            row.app ?? '',
            row.activityType ?? '',
            row.title ?? '',
            row.summary ?? '',
        ]);
    }

    return values;
};

/**
 * Crea el Sheet del reporte en el Drive del usuario y devuelve su URL.
 * Best-effort: ante cualquier fallo loguea y devuelve `null` (no propaga).
 *
 * @param {{ id: string }} user - usuario dueño del reporte (req.user)
 * @param {{ id: string, reportDate: Date }} report - reporte ya persistido
 * @param {import('../ai/ai.output.types').AIModuleOutput} aiOutput - contenido del reporte
 * @returns {Promise<string|null>} `spreadsheetUrl` o `null`
 */
const createReportSheet = async (user, report, aiOutput) => {
    try {
        const refreshToken = await getDecryptedRefreshToken(user.id);
        if (!refreshToken) {
            logger.info('reports.sheet.skipped', {
                userId: user.id,
                reportId: report.id,
                reason: 'no_google_token',
            });
            return null;
        }

        const auth = getAuthenticatedGoogleClient(refreshToken);
        const sheets = google.sheets({ version: 'v4', auth });

        const title = new Date(report.reportDate).toISOString().split('T')[0]; // YYYY-MM-DD

        // 1) Crear el spreadsheet (vacío, con título = fecha del reporte).
        const created = await sheets.spreadsheets.create({
            requestBody: { properties: { title } },
        });

        const spreadsheetId = created.data.spreadsheetId;
        const spreadsheetUrl = created.data.spreadsheetUrl;

        // 2) Escribir los valores con USER_ENTERED (ver header del archivo).
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: 'A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: buildSheetValues(aiOutput) },
        });

        logger.info('reports.sheet.created', { userId: user.id, reportId: report.id });
        return spreadsheetUrl || null;
    } catch (error) {
        if (looksLikeGoogleAuthError(error)) {
            await markGoogleReconnect(user.id);
        }
        logger.warn('reports.sheet.failed', {
            userId: user.id,
            reportId: report.id,
            message: error.message,
            code: error.code,
        });
        return null;
    }
};

module.exports = { createReportSheet, buildSheetValues };
