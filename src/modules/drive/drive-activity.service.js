const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { sanitizeText, MAX_TITLE_CHARS } = require('../../shared/utils/sanitize');

/**
 * Error tipado para una ventana [startTime, endTime) inválida (fechas no
 * parseables o startTime >= endTime). El controller lo mapea a 400.
 */
class InvalidWindowError extends Error {
    constructor(message = 'Ventana inválida: startTime y endTime deben ser ISO 8601 y startTime < endTime') {
        super(message);
        this.name = 'InvalidWindowError';
        this.statusCode = 400;
    }
}

// Tipos de acción que representan trabajo activo sobre un archivo
const RELEVANT_ACTIONS = new Set(['edit', 'create']);

// Acciones que se cuentan en el resumen por archivo
const SUMMARY_ACTIONS = new Set(['edit', 'create', 'comment', 'permissionChange']);

// MIME types a excluir: no son archivos de trabajo sino contenedores o atajos
const EXCLUDED_MIME_TYPES = new Set([
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.shortcut',
]);

// Tope defensivo de páginas. Con pageSize=100 cubre 10.000 actividades en un
// día, muy por encima de cualquier volumen humano real. Protege contra un
// nextPageToken que cicle (bug de la API) sin truncar datos legítimos.
const MAX_PAGES = 100;

// Mapeo de mimeType de Google Workspace a nombre de aplicación legible
const MIME_TO_APP = {
    'application/vnd.google-apps.document':     'Google Docs',
    'application/vnd.google-apps.spreadsheet':  'Google Sheets',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form':         'Google Forms',
    'application/vnd.google-apps.drawing':      'Google Drawings',
    'application/vnd.google-apps.script':       'Apps Script',
    'application/vnd.google-apps.site':         'Google Sites',
    'application/vnd.google-apps.jam':          'Google Jamboard',
};

/**
 * Consulta la Drive Activity API para el rango de tiempo dado.
 * Maneja la paginación automáticamente hasta agotar los resultados.
 *
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @param {string} timeMin      - Inicio del rango en ISO 8601 (UTC)
 * @param {string} timeMax      - Fin del rango en ISO 8601 (UTC)
 * @returns {Promise<object[]>} - Array de DriveActivity crudos de la API
 */
const getDriveActivitiesForDay = async (refreshToken, timeMin, timeMax) => {
    try {
        const auth = getAuthenticatedGoogleClient(refreshToken);
        const driveactivity = google.driveactivity({ version: 'v2', auth });

        const activities = [];
        let nextPageToken = null;
        let pages = 0;

        do {
            const response = await driveactivity.activity.query({
                requestBody: {
                    ancestorName: 'items/root',
                    filter: `time >= "${timeMin}" AND time < "${timeMax}"`,
                    consolidationStrategy: { legacy: {} },
                    pageSize: 100,
                    ...(nextPageToken && { pageToken: nextPageToken }),
                },
            });

            const page = response.data.activities || [];
            activities.push(...page);
            nextPageToken = response.data.nextPageToken || null;
            pages += 1;
        } while (nextPageToken && pages < MAX_PAGES);

        if (nextPageToken) {
            logger.warn('Tope de páginas de Drive Activity alcanzado', { pages, collected: activities.length });
        }

        return activities;
    } catch (error) {
        logger.error('Error al obtener actividades de Drive', { message: error.message, code: error.code });
        throw new Error('Error al obtener actividades de Drive', { cause: error });
    }
};

/**
 * Persiste las actividades de Drive del día indicado en la BD.
 * Filtra por tipo de acción relevante y excluye carpetas y accesos directos.
 * Usa skipDuplicates para ser idempotente si se llama varias veces el mismo día.
 *
 * @param {string} userId         - ID del usuario en el sistema
 * @param {string} refreshToken   - Refresh token del usuario (ya descifrado)
 * @param {string|Date} startTime - Inicio de la ventana (ISO 8601 con TZ).
 * @param {string|Date} endTime   - Fin de la ventana, exclusivo (ISO 8601 con TZ).
 * @returns {Promise<{count: number, message: string}>}
 * @throws {InvalidWindowError} si la ventana es inválida.
 */
const persistDriveActivities = async (userId, refreshToken, startTime, endTime) => {
    // La ventana llega ya resuelta a instantes absolutos (UTC). El caller —hoy
    // el endpoint para probar por Postman, mañana el batch— es responsable de
    // armarla a partir de la jornada laboral del usuario (hora inicio/fin + TZ
    // que vivirán en la BD). Acá solo se valida y se usa.
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        throw new InvalidWindowError();
    }
    const timeMin = start.toISOString();
    const timeMax = end.toISOString();

    const rawActivities = await getDriveActivitiesForDay(refreshToken, timeMin, timeMax);

    const activitiesToSave = [];

    for (const activity of rawActivities) {
        // Tipo de acción principal
        const actionType = activity.primaryActionDetail
            ? Object.keys(activity.primaryActionDetail)[0]
            : null;

        if (!actionType || !RELEVANT_ACTIONS.has(actionType)) continue;

        // Archivo afectado
        const target = activity.targets?.[0]?.driveItem;
        if (!target) continue;

        const mimeType = target.mimeType || '';
        if (EXCLUDED_MIME_TYPES.has(mimeType)) continue;

        // La API devuelve timestamp (evento puntual) o timeRange (sesión de trabajo)
        const startTime = activity.timeRange
            ? new Date(activity.timeRange.startTime)
            : new Date(activity.timestamp);
        const endTime = activity.timeRange
            ? new Date(activity.timeRange.endTime)
            : new Date(activity.timestamp);

        const fileId = target.name?.replace('items/', '') || null;

        // externalId sintético para deduplicación (la API no expone un ID estable por actividad)
        const rawTimestamp = activity.timeRange
            ? activity.timeRange.startTime
            : activity.timestamp;
        const externalId = fileId && rawTimestamp
            ? `${actionType}_${fileId}_${rawTimestamp}`
            : null;

        activitiesToSave.push({
            userId,
            source: 'drive',
            activityType: actionType,
            externalId,
            startTime,
            endTime,
            metadata: {
                // Saneamos + truncamos el nombre del archivo (fuente externa: Drive, incl.
                // archivos compartidos por terceros) antes de persistirlo en la JSON column.
                title: sanitizeText(target.title, MAX_TITLE_CHARS) || null,
                fileId,
                mimeType: mimeType || null,
            },
        });
    }

    if (activitiesToSave.length === 0) {
        return { count: 0, message: 'No se encontraron actividades relevantes de Drive para guardar' };
    }

    const result = await prisma.dailyActivity.createMany({
        data: activitiesToSave,
        skipDuplicates: true,
    });

    return { count: result.count, message: `${result.count} actividades de Drive guardadas` };
};

/**
 * Agrupa actividades crudas de Drive por archivo y cuenta las acciones
 * relevantes (edit/create, comment, permissionChange) por cada uno.
 *
 * Las carpetas y accesos directos se excluyen del resumen.
 * Las acciones que no pertenecen a SUMMARY_ACTIONS se ignoran.
 *
 * @param {object[]} rawActivities - Array crudo devuelto por getDriveActivitiesForDay
 * @returns {Array<{
 *   fileId: string,
 *   title: string|null,
 *   mimeType: string|null,
 *   editCount: number,
 *   commentCount: number,
 *   shareCount: number,
 *   totalActions: number
 * }>}
 */
const summarizeDriveActivities = (rawActivities) => {
    // fileId → acumulador de conteos
    const byFile = new Map();

    for (const activity of rawActivities) {
        const actionType = activity.primaryActionDetail
            ? Object.keys(activity.primaryActionDetail)[0]
            : null;

        if (!actionType || !SUMMARY_ACTIONS.has(actionType)) continue;

        const target = activity.targets?.[0]?.driveItem;
        if (!target) continue;

        const mimeType = target.mimeType || null;
        if (EXCLUDED_MIME_TYPES.has(mimeType)) continue;

        const fileId = target.name?.replace('items/', '') || null;
        if (!fileId) continue;

        if (!byFile.has(fileId)) {
            byFile.set(fileId, {
                fileId,
                title: sanitizeText(target.title, MAX_TITLE_CHARS) || null,
                mimeType,
                editCount: 0,
                commentCount: 0,
                shareCount: 0,
            });
        }

        const entry = byFile.get(fileId);

        if (actionType === 'edit' || actionType === 'create') {
            entry.editCount += 1;
        } else if (actionType === 'comment') {
            entry.commentCount += 1;
        } else if (actionType === 'permissionChange') {
            entry.shareCount += 1;
        }
    }

    return Array.from(byFile.values()).map((entry) => ({
        ...entry,
        totalActions: entry.editCount + entry.commentCount + entry.shareCount,
    }));
};

/**
 * Enriquece el resumen de actividades de Drive con metadata actualizada de
 * la Drive API v3 (name, mimeType, webViewLink) y determina la app de
 * Google Workspace según el mimeType.
 *
 * Las llamadas a files.get se hacen en paralelo. Si un archivo no es
 * accesible (eliminado, sin permiso, error de red), se conserva la entrada
 * con los datos del resumen original y app: null, sin interrumpir el resto.
 *
 * @param {Array<{fileId: string, title: string|null, mimeType: string|null, editCount: number, commentCount: number, shareCount: number, totalActions: number}>} summary
 *   Resultado de summarizeDriveActivities
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @returns {Promise<Array<{fileId: string, title: string|null, mimeType: string|null, webViewLink: string|null, app: string|null, editCount: number, commentCount: number, shareCount: number, totalActions: number}>>}
 */
const enrichDriveActivitySummary = async (summary, refreshToken) => {
    if (summary.length === 0) return [];

    const auth = getAuthenticatedGoogleClient(refreshToken);
    const drive = google.drive({ version: 'v3', auth });

    const results = await Promise.allSettled(
        summary.map((entry) =>
            drive.files.get({
                fileId: entry.fileId,
                fields: 'id,name,mimeType,webViewLink',
            })
        )
    );

    return summary.map((entry, i) => {
        const outcome = results[i];

        if (outcome.status === 'rejected') {
            logger.warn('No se pudo obtener metadata del archivo de Drive', {
                fileId: entry.fileId,
                error: outcome.reason?.message,
            });
            return { ...entry, webViewLink: null, app: null };
        }

        const { name, mimeType, webViewLink } = outcome.value.data;

        return {
            ...entry,
            title: sanitizeText(name, MAX_TITLE_CHARS) || entry.title,
            mimeType: mimeType || entry.mimeType,
            webViewLink: webViewLink || null,
            app: MIME_TO_APP[mimeType] ?? null,
        };
    });
};

module.exports = {
    getDriveActivitiesForDay,
    persistDriveActivities,
    summarizeDriveActivities,
    enrichDriveActivitySummary,
    InvalidWindowError,
};
