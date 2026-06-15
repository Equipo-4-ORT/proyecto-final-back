const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');
const { sanitizeText, MAX_TITLE_CHARS } = require('../../shared/utils/sanitize');
const { mapWithConcurrency } = require('../../shared/utils/concurrency');

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

// Acciones de edición/modificación directa del contenido
const EDIT_ACTIONS = new Set(['edit', 'create', 'rename']);

// Acciones de colaboración
const COMMENT_ACTIONS = new Set(['comment', 'suggestion']);

// Acciones de organización y permisos
const SHARE_ACTIONS = new Set(['permissionChange', 'move', 'restore', 'delete']);

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

// Mapeo de mimeType al activityType que se persiste en DailyActivity.
// Permite al timeline mostrar el ícono/label correcto sin leer metadata.
// Los tipos que no están en la lista caen al valor genérico 'file'.
const MIME_TO_ACTIVITY_TYPE = {
    'application/vnd.google-apps.document':     'document',
    'application/vnd.google-apps.spreadsheet':  'spreadsheet',
    'application/vnd.google-apps.presentation': 'presentation',
    'application/vnd.google-apps.form':         'form',
    'application/vnd.google-apps.drawing':      'drawing',
    'application/vnd.google-apps.script':       'script',
};

const ACTION_LABELS = {
    edit:             'Editó',
    create:           'Creó',
    rename:           'Renombró',
    permissionChange: 'Cambió permisos de',
    comment:          'Comentó en',
    suggestion:       'Sugirió en',
    move:             'Movió',
    delete:           'Eliminó',
    restore:          'Restauró',
};

// Tope de llamadas simultáneas a la Drive API al enriquecer el resumen. Evita
// gatillar rate limits (userRateLimitExceeded) en días con muchos archivos.
const ENRICH_CONCURRENCY = 10;

// Estimación de duración de trabajo por archivo:
// se suma a la última acción para dar un buffer de "cierre de pestaña".
const WORK_BUFFER_MS = 5 * 60 * 1000;        // 5 min

// Tope de duración estimada por archivo en una misma ventana de sync.
// Evita que un archivo con acciones muy separadas infle el timeline.
const MAX_WORK_DURATION_MS = 2 * 60 * 60 * 1000; // 2 h

// Tope máximo de la ventana de sync. Defiende contra ventanas absurdamente
// amplias (un error de cálculo del batch o una prueba a mano) que dispararían
// muchas páginas contra la Drive API. El caso real es una jornada laboral (~1 día).
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000; // 31 días

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

    const rawTarget = activity.targets?.[0];
    if (!rawTarget) return null;

    // Los comentarios apuntan a fileComment; el driveItem padre es el archivo real
    const target = rawTarget.driveItem
        ?? rawTarget.fileComment?.parent
        ?? null;
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
/**
 * Ejecuta una query paginada contra la Drive Activity API y devuelve todos
 * los resultados. Usado internamente por getDriveActivitiesForDay.
 */
const queryDriveActivityPaginated = async (driveactivity, requestBody) => {
    const activities = [];
    let nextPageToken = null;
    let pages = 0;

    do {
        const response = await driveactivity.activity.query({
            requestBody: {
                ...requestBody,
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
};

const getDriveActivitiesForDay = async (refreshToken, timeMin, timeMax) => {
    try {
        const auth = getAuthenticatedGoogleClient(refreshToken);
        const driveactivity = google.driveactivity({ version: 'v2', auth });
        const timeFilter = `time >= "${timeMin}" AND time < "${timeMax}"`;

        // Query principal: todas las acciones con consolidación legacy.
        // La consolidación agrupa acciones del mismo tipo sobre el mismo archivo,
        // pero puede suprimir permissionChange cuando coexiste con create/edit.
        const mainActivities = await queryDriveActivityPaginated(driveactivity, {
            filter: timeFilter,
            consolidationStrategy: { legacy: {} },
            pageSize: 100,
        });

        // Query separada para permissionChange: la consolidación legacy lo omite
        // cuando hay otras acciones más relevantes sobre el mismo archivo.
        const permissionActivities = await queryDriveActivityPaginated(driveactivity, {
            filter: `${timeFilter} AND detail.action_detail_case:PERMISSION_CHANGE`,
            consolidationStrategy: { none: {} },
            pageSize: 100,
        });

        // Query separada para edit: la consolidación legacy puede suprimirlo
        // cuando coexiste con create/rename sobre el mismo archivo.
        const editActivities = await queryDriveActivityPaginated(driveactivity, {
            filter: `${timeFilter} AND detail.action_detail_case:EDIT`,
            consolidationStrategy: { none: {} },
            pageSize: 100,
        });

        // Construir set de claves ya presentes en mainActivities para deduplicar.
        const mainKeysByAction = (actionName) => new Set(
            mainActivities
                .filter(a => Object.keys(a.primaryActionDetail || {})[0] === actionName)
                .map(a => `${a.targets?.[0]?.driveItem?.name}_${a.timestamp}`)
        );

        const mainPermissionKeys = mainKeysByAction('permissionChange');
        const mainEditKeys = mainKeysByAction('edit');

        const newPermissions = permissionActivities.filter(a => {
            const key = `${a.targets?.[0]?.driveItem?.name}_${a.timestamp}`;
            return !mainPermissionKeys.has(key);
        });

        const newEdits = editActivities.filter(a => {
            const key = `${a.targets?.[0]?.driveItem?.name}_${a.timestamp}`;
            return !mainEditKeys.has(key);
        });

        return [...mainActivities, ...newPermissions, ...newEdits];
    } catch (error) {
        logger.error('Error al obtener actividades de Drive', { message: error.message, code: error.code });
        throw new Error('Error al obtener actividades de Drive', { cause: error });
    }
};

/**
 * Estima la duración de trabajo por archivo a partir de sus acciones crudas.
 *
 * Agrupa todos los timestamps de acciones relevantes del archivo y calcula:
 *   startTime = primera acción
 *   endTime   = min(última acción + WORK_BUFFER_MS, primera acción + MAX_WORK_DURATION_MS)
 *
 * Esto hace que cada archivo aparezca con una barra de duración real en el
 * timeline, en lugar de un punto sin extensión (que era el resultado cuando
 * la API devolvía un timestamp puntual para cada acción).
 *
 * @param {Map<string, {fileId: string, title: string|null, mimeType: string|null, timestampsMs: number[]}>} byFile
 *   Mapa de fileId → datos acumulados del archivo.
 * @param {string} userId
 * @param {string} windowDate - Fecha de la ventana de sync en formato YYYY-MM-DD (para el externalId).
 * @returns {Array<object>} Registros listos para createMany en DailyActivity.
 */
const buildWorkEstimates = (byFile, userId, windowDate) => {
    const records = [];

    for (const [, data] of byFile) {
        const firstMs = data.timestampsMs.reduce((a, b) => Math.min(a, b));
        const lastMs  = data.timestampsMs.reduce((a, b) => Math.max(a, b));

        const startTime = new Date(firstMs);
        // endTime = la sesión real (lastMs) o mínimo 5 min desde el inicio, lo que sea mayor.
        // Tope de 2 hs para evitar que acciones muy separadas inflen el timeline.
        const rawEnd = Math.max(lastMs, firstMs + WORK_BUFFER_MS);
        const endTime = new Date(Math.min(rawEnd, firstMs + MAX_WORK_DURATION_MS));

        // externalId incluye actionType para que cada acción sobre el mismo archivo
        // genere un registro independiente en BD.
        const externalId = `file_${data.fileId}_${data.actionType}_${windowDate}`;

        const fileType = MIME_TO_ACTIVITY_TYPE[data.mimeType] ?? 'file';

        const actionLabel = ACTION_LABELS[data.actionType] ?? data.actionType;
        const title = data.title ? `${actionLabel} ${data.title}` : actionLabel;

        records.push({
            userId,
            source: 'drive',
            activityType: data.actionType,
            fileType,
            externalId,
            startTime,
            endTime,
            title,
            metadata: { title, fileId: data.fileId, mimeType: data.mimeType },
        });
    }

    return records;
};

/**
 * Persiste las actividades de Drive del día indicado en la BD.
 *
 * En lugar de guardar un registro por acción, agrupa por archivo y estima
 * la duración de trabajo: desde la primera acción hasta la última + 5 min
 * de buffer, con un tope de 2 h. Así las actividades de Drive aparecen con
 * duración real en el timeline (en lugar de un punto de duración cero).
 *
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
    if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
        throw new InvalidWindowError('Ventana demasiado amplia: el máximo permitido es 31 días');
    }
    const timeMin = start.toISOString();
    const timeMax = end.toISOString();

    // Fecha local de la ventana (YYYY-MM-DD) usada en el externalId.
    // Se toma del inicio de la ventana en UTC: un sync por jornada laboral
    // siempre cae en el mismo día calendario.
    const windowDate = start.toISOString().slice(0, 10);

    const rawActivities = await getDriveActivitiesForDay(refreshToken, timeMin, timeMax);

    logger.info('Drive raw activities', {
        total: rawActivities.length,
        actions: rawActivities.map(a => ({
            action: a.primaryActionDetail ? Object.keys(a.primaryActionDetail)[0] : null,
            targetType: a.targets?.[0] ? Object.keys(a.targets[0])[0] : null,
            title: a.targets?.[0]?.driveItem?.title,
        })),
    });

    // Acumular timestamps por archivo+acción — cada tipo de acción sobre un
    // archivo genera un registro separado en el timeline.
    const byFile = new Map();

    for (const activity of rawActivities) {
        const extracted = extractDriveTarget(activity);
        if (!extracted) continue;

        const { actionType, fileId, mimeType, title } = extracted;
        if (!fileId) continue;

        // La API devuelve timestamp (evento puntual) o timeRange (sesión de trabajo).
        // Para la estimación usamos el instante de inicio de la acción en ambos casos.
        const tsMs = activity.timeRange
            ? new Date(activity.timeRange.startTime).getTime()
            : new Date(activity.timestamp).getTime();

        // Clave compuesta: fileId + actionType → un registro por acción por archivo
        const key = `${fileId}__${actionType}`;
        if (!byFile.has(key)) {
            byFile.set(key, { fileId, actionType, mimeType, title, timestampsMs: [] });
        }
        const entry = byFile.get(key);
        entry.timestampsMs.push(tsMs);
        if (!entry.title && title) entry.title = title;
    }

    if (byFile.size === 0) {
        return { count: 0, message: 'No se encontraron actividades relevantes de Drive para guardar' };
    }

    const activitiesToSave = buildWorkEstimates(byFile, userId, windowDate);

    // Determinar cuáles externalIds ya existen para separar creates de updates.
    const externalIds = activitiesToSave.map((r) => r.externalId);
    const existing = await prisma.dailyActivity.findMany({
        where: { userId, source: 'drive', externalId: { in: externalIds } },
        select: { externalId: true },
    });
    const existingSet = new Set(existing.map((r) => r.externalId));

    await prisma.$transaction(
        activitiesToSave.map((record) =>
            prisma.dailyActivity.upsert({
                where: {
                    userId_source_externalId: {
                        userId: record.userId,
                        source: record.source,
                        externalId: record.externalId,
                    },
                },
                create: record,
                update: {
                    startTime:    record.startTime,
                    endTime:      record.endTime,
                    activityType: record.activityType,
                    fileType:     record.fileType,
                    title:        record.title,
                    metadata:     record.metadata,
                },
            })
        )
    );

    const created = activitiesToSave.filter((r) => !existingSet.has(r.externalId)).length;
    const updated = activitiesToSave.length - created;

    if (created === 0 && updated > 0) {
        return { created: 0, updated, message: `${updated} actividades actualizadas` };
    }
    if (updated === 0) {
        return { created, updated: 0, message: `${created} actividades guardadas` };
    }
    return { created, updated, message: `${created} actividades guardadas, ${updated} actualizadas` };
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
        if (!extracted) continue;

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

        if (EDIT_ACTIONS.has(actionType)) {
            entry.editCount += 1;
        } else if (COMMENT_ACTIONS.has(actionType)) {
            entry.commentCount += 1;
        } else if (SHARE_ACTIONS.has(actionType)) {
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
    buildWorkEstimates,
    summarizeDriveActivities,
    enrichDriveActivitySummary,
    InvalidWindowError,
    WORK_BUFFER_MS,
    MAX_WORK_DURATION_MS,
    MIME_TO_ACTIVITY_TYPE,
};
