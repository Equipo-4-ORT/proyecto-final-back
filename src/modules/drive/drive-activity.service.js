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

// Tope de llamadas simultáneas a la Drive API al enriquecer el resumen. Evita
// gatillar rate limits (userRateLimitExceeded) en días con muchos archivos.
const ENRICH_CONCURRENCY = 10;

/**
 * Ejecuta `fn` sobre cada item con un pool de a lo sumo `limit` ejecuciones en
 * simultáneo. A diferencia de procesar en bloques fijos, apenas un "carril"
 * termina toma el siguiente pendiente (sin tiempos muertos). Procesa TODOS los
 * items: solo acota cuántos corren a la vez. Preserva el orden de entrada.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit - máximo de ejecuciones concurrentes
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
const mapWithConcurrency = async (items, limit, fn) => {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
};

/**
 * Extrae de una DriveActivity cruda los datos comunes que usan tanto el
 * persistido como el resumen: tipo de acción principal, fileId, mimeType y
 * título saneado. Fuente única de verdad para no duplicar el parseo entre
 * persistDriveActivities y summarizeDriveActivities.
 *
 * Devuelve null si la actividad no tiene acción o target usable, o si el
 * archivo es una carpeta / acceso directo (excluidos).
 *
 * @param {object} activity - DriveActivity cruda de la API
 * @returns {{actionType: string, fileId: string|null, mimeType: string|null, title: string|null}|null}
 */
const extractDriveTarget = (activity) => {
    const actionType = activity.primaryActionDetail
        ? Object.keys(activity.primaryActionDetail)[0]
        : null;
    if (!actionType) return null;

    const target = activity.targets?.[0]?.driveItem;
    if (!target) return null;

    const mimeType = target.mimeType || null;
    if (EXCLUDED_MIME_TYPES.has(mimeType)) return null;

    return {
        actionType,
        fileId: target.name?.replace('items/', '') || null,
        mimeType,
        title: sanitizeText(target.title, MAX_TITLE_CHARS) || null,
    };
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
        const extracted = extractDriveTarget(activity);
        if (!extracted || !RELEVANT_ACTIONS.has(extracted.actionType)) continue;

        const { actionType, fileId, mimeType, title } = extracted;

        // La API devuelve timestamp (evento puntual) o timeRange (sesión de trabajo)
        const startTime = activity.timeRange
            ? new Date(activity.timeRange.startTime)
            : new Date(activity.timestamp);
        const endTime = activity.timeRange
            ? new Date(activity.timeRange.endTime)
            : new Date(activity.timestamp);

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
            // title ya viene saneado + truncado desde extractDriveTarget (fuente externa: Drive,
            // incl. archivos compartidos por terceros) antes de persistirlo en la JSON column.
            metadata: { title, fileId, mimeType },
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

// TODO (incremental): summarizeDriveActivities y enrichDriveActivitySummary todavía
// no están conectadas a ningún endpoint ni orquestador (el controller solo usa
// persistDriveActivities). El wiring —ruta + controller, o una función orquestadora
// getDriveActivitiesForDay → summarize → enrich— queda para el próximo incremento.
// Por ahora se entregan a nivel servicio + tests.

/**
 * Agrupa actividades crudas de Drive por archivo y cuenta las acciones
 * relevantes (edit/create, comment, permissionChange) por cada uno.
 *
 * Los contadores reflejan ACTIVIDADES CONSOLIDADAS, no eventos crudos: el query
 * usa consolidationStrategy "legacy", que agrupa acciones similares sobre el
 * mismo archivo dentro de una ventana. Es intencional: nos interesa "el usuario
 * trabajó en este archivo", no contar 30 comentarios sueltos. (No mide tiempo en
 * el archivo; eso sería un cálculo aparte sobre timeRange — pendiente/backlog.)
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
        const extracted = extractDriveTarget(activity);
        if (!extracted || !SUMMARY_ACTIONS.has(extracted.actionType)) continue;

        const { actionType, fileId, mimeType, title } = extracted;
        if (!fileId) continue;

        if (!byFile.has(fileId)) {
            byFile.set(fileId, {
                fileId,
                title,
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
 * Las llamadas a files.get se hacen con concurrencia acotada (ENRICH_CONCURRENCY)
 * para no gatillar rate limits. Si un archivo no es accesible (eliminado, sin
 * permiso, error de red), se conserva la entrada con los datos del resumen
 * original y la app se deriva del mimeType del resumen, sin interrumpir el resto.
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

    // Concurrencia acotada: limita cuántos files.get corren en simultáneo para no
    // gatillar rate limits de Drive. No se pierde data: se llama igual por cada
    // archivo, solo cambia cuántos van a la vez. Cada llamada se envuelve para
    // emular la forma { status, value | reason } de Promise.allSettled.
    const results = await mapWithConcurrency(summary, ENRICH_CONCURRENCY, (entry) =>
        drive.files
            .get({
                fileId: entry.fileId,
                fields: 'name,mimeType,webViewLink',
                supportsAllDrives: true,
            })
            .then((value) => ({ status: 'fulfilled', value }))
            .catch((reason) => ({ status: 'rejected', reason })),
    );

    return summary.map((entry, i) => {
        const outcome = results[i];

        if (outcome.status === 'rejected') {
            logger.warn('No se pudo obtener metadata del archivo de Drive', {
                fileId: entry.fileId,
                error: outcome.reason?.message,
            });
            // Aun sin metadata fresca conservamos el mimeType del resumen, así
            // seguimos pudiendo mostrar la app (p. ej. "Google Docs").
            return { ...entry, webViewLink: null, app: MIME_TO_APP[entry.mimeType] ?? null };
        }

        const { name, mimeType, webViewLink } = outcome.value.data;
        // app se deriva del mimeType resuelto (fresco con fallback al del resumen),
        // para que nunca queden mimeType y app contradictorios.
        const resolvedMimeType = mimeType || entry.mimeType;

        return {
            ...entry,
            title: sanitizeText(name, MAX_TITLE_CHARS) || entry.title,
            mimeType: resolvedMimeType,
            webViewLink: webViewLink || null,
            app: MIME_TO_APP[resolvedMimeType] ?? null,
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
