const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const prisma = require('../../shared/database/prisma');
const logger = require('../../shared/utils/logger');

// Tipos de acción que representan trabajo activo sobre un archivo
const RELEVANT_ACTIONS = new Set(['edit', 'create']);

// MIME types a excluir: no son archivos de trabajo sino contenedores o atajos
const EXCLUDED_MIME_TYPES = new Set([
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.shortcut',
]);

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
        } while (nextPageToken);

        return activities;
    } catch (error) {
        logger.error('Error al obtener actividades de Drive', { error });
        throw new Error('Error al obtener actividades de Drive', { cause: error });
    }
};

/**
 * Persiste las actividades de Drive del día indicado en la BD.
 * Filtra por tipo de acción relevante y excluye carpetas y accesos directos.
 * Usa skipDuplicates para ser idempotente si se llama varias veces el mismo día.
 *
 * @param {string} userId       - ID del usuario en el sistema
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @param {string} dateStr      - Fecha en formato YYYY-MM-DD
 * @returns {Promise<{count: number, message: string}>}
 */
const persistDriveActivities = async (userId, refreshToken, dateStr) => {
    const startDate = new Date(dateStr);
    const timeMin = startDate.toISOString();

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const timeMax = endDate.toISOString();

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
                title: target.title || null,
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

module.exports = {
    getDriveActivitiesForDay,
    persistDriveActivities,
};
