/**
 * Timeline service — agrupamiento de actividades por app.
 *
 * Exporta:
 *   - groupByApp(activities): clasifica activities en buckets por app
 *     (Meet/Docs/Sheets/Slides/Drive/Calendar/Jira/Other). Pensada para
 *     armar el payload del informe a la IA y/o categorizar en respuestas
 *     al front.
 *   - isSafeDomain(url, domain): helper interno de groupByApp para validar
 *     que un link efectivamente pertenece a un dominio esperado (anti
 *     spoofing tipo `evilmeet.google.com` o `meet.google.com.attacker.com`).
 *
 * Nota: la normalización de endTime ausente y el ordenamiento cronológico
 * NO viven acá. La normalización es responsabilidad del adapter de cada
 * source en el cron de sync (antes del INSERT, porque el schema tiene
 * endTime NOT NULL). El ordenamiento lo da Prisma con
 * `orderBy: { startTime: 'asc' }` al leer.
 *
 * Cuando se implemente la setting de "no permitir solapamientos", el
 * chequeo va a ser una función nueva tipo `findOverlaps(sortedActivities)`
 * — no agregarla acá si no encaja con el rol del módulo.
 */

const isSafeDomain = (urlString, targetDomain) => {
    if (!urlString) return false;
    try {
        const url = new URL(urlString);
        return url.hostname === targetDomain || url.hostname.endsWith(`.${targetDomain}`);
    } catch {
        return false;
    }
};


const groupByApp = (activities = []) => {
    const grouped = {
        Meet: [],
        Docs: [],
        Sheets: [],
        Slides: [],
        Drive: [],
        Calendar: [],
        Jira: [],
        Other: [],
    };

    activities.forEach(activity => {
        const source = (activity.source || '').toLowerCase();
        const metadata = activity.metadata || {};
        const link = (metadata.link || '').toLowerCase();
        const mimeType = (metadata.mimeType || '').toLowerCase();

        if (source === 'calendar') {
            // TODO: cuando el sync de Calendar popule `metadata.link` con
            // `hangoutLink`/`conferenceData`, este check será suficiente.
            // Por ahora un evento sin link cae a Calendar aunque sea de Meet.
            if (isSafeDomain(link, 'meet.google.com')) {
                grouped.Meet.push(activity);
            } else {
                grouped.Calendar.push(activity);
            }
        } else if (source === 'drive') {
            if (mimeType.includes('document') || isSafeDomain(link, 'docs.google.com')) {
                grouped.Docs.push(activity);
            } else if (mimeType.includes('spreadsheet') || isSafeDomain(link, 'sheets.google.com')) {
                grouped.Sheets.push(activity);
            } else if (mimeType.includes('presentation') || isSafeDomain(link, 'slides.google.com')) {
                grouped.Slides.push(activity);
            } else {
                grouped.Drive.push(activity);
            }
        } else if (source === 'jira') {
            grouped.Jira.push(activity);
        } else {
            // 'manual' y cualquier source desconocido caen acá para evitar
            // pérdida silenciosa de datos.
            grouped.Other.push(activity);
        }
    });

    return grouped;
};

module.exports = {
    isSafeDomain,
    groupByApp,
};
