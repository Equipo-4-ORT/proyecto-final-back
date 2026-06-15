const { google } = require('googleapis');
const { getAuthenticatedGoogleClient } = require('../google/google.service');
const logger = require('../../shared/utils/logger');

/**
 * Enumeración del alcance de Drive de un empleado para la recolección de
 * actividad. La Drive Activity API solo consulta "Mi unidad" (ancestorName
 * items/root) si no se le indica otra cosa, dejando fuera los documentos
 * creados por otras personas o ubicados en Unidades compartidas / "Compartido
 * conmigo". Este módulo arma la lista de scopes para cubrir las tres ubicaciones.
 */

// MIME types excluidos de la enumeración de "Compartido conmigo": son
// contenedores o atajos, no archivos de trabajo. Se replica el criterio de
// EXCLUDED_MIME_TYPES de drive-activity.service para evitar una dependencia
// circular entre ambos módulos.
const EXCLUDED_MIME_TYPES = new Set([
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.shortcut',
]);

// pageSize de files.list al enumerar "Compartido conmigo".
const SHARED_WITH_ME_PAGE_SIZE = 100;

// Tope defensivo de archivos "Compartido conmigo" a consultar por ventana. Cada
// archivo cuesta una query de actividad (itemName); el tope corta colas absurdas
// en empleados con miles de archivos compartidos (limitación conocida).
const MAX_SHARED_ITEMS = 500;

// Paginación de drives.list (las unidades compartidas suelen ser pocas; el tope
// de páginas es una defensa contra un nextPageToken cíclico).
const DRIVES_PAGE_SIZE = 100;
const MAX_DRIVES_PAGES = 50;

/**
 * Enumera las Unidades compartidas de las que el empleado es miembro como scopes
 * de tipo ancestorName. Si la API falla, devuelve [] (se omite esta ubicación,
 * la recolección continúa con las demás).
 *
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @returns {Promise<Array<{ancestorName: string}>>}
 */
const listSharedDriveScopes = async (refreshToken) => {
    try {
        const auth = getAuthenticatedGoogleClient(refreshToken);
        const drive = google.drive({ version: 'v3', auth });
        const scopes = [];
        let pageToken = null;
        let pages = 0;

        do {
            const res = await drive.drives.list({
                pageSize: DRIVES_PAGE_SIZE,
                fields: 'nextPageToken,drives(id)',
                ...(pageToken && { pageToken }),
            });
            for (const d of res.data.drives || []) {
                if (d.id) scopes.push({ ancestorName: `items/${d.id}` });
            }
            pageToken = res.data.nextPageToken || null;
            pages += 1;
        } while (pageToken && pages < MAX_DRIVES_PAGES);

        return scopes;
    } catch (error) {
        logger.warn('No se pudieron enumerar las unidades compartidas de Drive', {
            message: error.message,
            code: error.code,
        });
        return [];
    }
};

/**
 * Enumera los archivos "Compartido conmigo" (dueño = otra persona, fuera de
 * unidades compartidas) como scopes de tipo itemName. Excluye carpetas/atajos y
 * archivos en papelera, y aplica el tope MAX_SHARED_ITEMS. Si la API falla,
 * devuelve [].
 *
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @returns {Promise<Array<{itemName: string}>>}
 */
const listSharedWithMeScopes = async (refreshToken) => {
    try {
        const auth = getAuthenticatedGoogleClient(refreshToken);
        const drive = google.drive({ version: 'v3', auth });
        const scopes = [];
        let pageToken = null;

        do {
            const res = await drive.files.list({
                q: 'sharedWithMe = true and trashed = false',
                fields: 'nextPageToken,files(id,mimeType)',
                pageSize: SHARED_WITH_ME_PAGE_SIZE,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                ...(pageToken && { pageToken }),
            });

            for (const f of res.data.files || []) {
                if (!f.id || EXCLUDED_MIME_TYPES.has(f.mimeType)) continue;
                scopes.push({ itemName: `items/${f.id}` });
                if (scopes.length >= MAX_SHARED_ITEMS) {
                    logger.warn('Tope de archivos "Compartido conmigo" alcanzado', { max: MAX_SHARED_ITEMS });
                    return scopes;
                }
            }
            pageToken = res.data.nextPageToken || null;
        } while (pageToken);

        return scopes;
    } catch (error) {
        logger.warn('No se pudieron enumerar los archivos "Compartido conmigo" de Drive', {
            message: error.message,
            code: error.code,
        });
        return [];
    }
};

/**
 * Arma la lista completa de scopes a consultar: "Mi unidad" (items/root) +
 * cada unidad compartida + cada archivo "Compartido conmigo". Las dos
 * enumeraciones corren en paralelo y son tolerantes a fallo (cada una devuelve
 * [] si su API falla).
 *
 * @param {string} refreshToken - Refresh token del usuario (ya descifrado)
 * @returns {Promise<Array<{ancestorName: string}|{itemName: string}>>}
 */
const buildDriveScopes = async (refreshToken) => {
    const [sharedDrives, sharedWithMe] = await Promise.all([
        listSharedDriveScopes(refreshToken),
        listSharedWithMeScopes(refreshToken),
    ]);

    logger.info?.('Scopes de Drive enumerados', {
        sharedDrives: sharedDrives.length,
        sharedWithMe: sharedWithMe.length,
    });

    return [{ ancestorName: 'items/root' }, ...sharedDrives, ...sharedWithMe];
};

module.exports = {
    listSharedDriveScopes,
    listSharedWithMeScopes,
    buildDriveScopes,
    EXCLUDED_MIME_TYPES,
    MAX_SHARED_ITEMS,
};
