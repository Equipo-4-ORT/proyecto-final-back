/**
 * Helpers de saneo de strings que vienen de fuentes externas (Google, Atlassian, etc.)
 * antes de persistirlos o exponerlos. Compartidos por los mappers de Jira, Drive y Calendar.
 */

// —— Topes por defecto para campos legibles que se guardan en la JSON column ——
// Una fuente externa no es confiable: un valor adversarial podría ser arbitrariamente
// grande. Truncamos antes de persistir. Cada módulo puede pasar su propio cap.
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;

/** Elimina CR/LF para prevenir log injection (CWE-117). */
const sanitizeForLog = (value) => String(value).replace(/[\r\n]/g, '');

/**
 * Normaliza texto de fuentes externas antes de persistirlo / exponerlo:
 *  - elimina control chars (0x00–0x1F, 0x7F) excepto whitespace común,
 *  - colapsa whitespace a un solo espacio,
 *  - trim,
 *  - trunca a `maxChars` (agrega ellipsis ASCII '...' si recorta).
 *
 * No escapa HTML: el contrato es que el consumidor (front React, IA) recibe
 * texto plano y lo renderiza por mecanismos que ya auto-escapan. Si en el
 * futuro alguien lo emite directo en HTML/CSV, debe escaparlo en ese punto.
 *
 * @param {unknown} value - valor crudo (cualquier tipo; defensivo).
 * @param {number} [maxChars] - tope del string resultado; sin tope si no es entero > 0.
 * @returns {string}
 */
const sanitizeText = (value, maxChars) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Strip control chars excepto \t \n \r — se colapsan a espacio en el paso siguiente.
    // eslint-disable-next-line no-control-regex
    const stripped = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const collapsed = stripped.replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(maxChars) || maxChars <= 0 || collapsed.length <= maxChars) {
        return collapsed;
    }
    return `${collapsed.slice(0, Math.max(0, maxChars - 3))}...`;
};

module.exports = { sanitizeForLog, sanitizeText, MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS };
