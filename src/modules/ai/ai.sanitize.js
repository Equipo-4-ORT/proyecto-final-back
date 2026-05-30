/**
 * Sanitización de strings para prevenir formula injection en Excel
 * y normalizar el contenido de usuario antes de mandarlo a la IA.
 *
 * Formula injection: Si un string comienza con =, +, -, o @,
 * Excel lo interpreta como fórmula. Escapamos con apóstrofo.
 *
 * Prompt injection: la mitigación real NO vive acá. Se logra con la
 * separación de roles system/user (instrucciones inmutables en el system
 * prompt, datos del usuario en el user prompt) más la validación del
 * output contra el schema AIModuleOutput. `sanitizeForPrompt` sólo
 * normaliza el texto removiendo caracteres de control — NO neutraliza
 * frases tipo "Ignore previous instructions"; no le atribuyas esa
 * protección.
 */

// Caracteres de control C0 (excepto \t=09, \n=0A, \r=0D), DEL (7F) y C1
// (80-9F). Se remueven porque pueden romper el formato del prompt o de las
// celdas, pero se preserva todo el Unicode imprimible (acentos, ñ, etc.).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Sanitiza un string para prevenir formula injection en Excel.
 * Si el string comienza con =, +, -, o @, lo prefija con apóstrofo.
 * @param {string} str - String a sanitizar
 * @returns {string} String sanitizado
 */
const sanitizeForExcel = (str) => {
    if (!str || typeof str !== 'string') return str;
    const dangerous = /^[=+\-@]/;
    return dangerous.test(str) ? `'${str}` : str;
};

/**
 * Normaliza un string antes de incluirlo en un prompt: remueve caracteres
 * de control (C0/C1 y DEL) que podrían romper el formato del mensaje, pero
 * conserva todo el texto imprimible, incluyendo acentos, ñ y demás
 * caracteres Unicode (clave para contenido en español).
 *
 * Importante: esto NO previene prompt injection (ver header del archivo).
 * @param {string} str - String a sanitizar
 * @returns {string} String sanitizado
 */
const sanitizeForPrompt = (str) => {
    if (!str || typeof str !== 'string') return str;
    return str.replace(CONTROL_CHARS, '').trim();
};

/**
 * Sanitiza recursivamente un objeto: todos los strings que sean
 * valores se procesan con sanitizeForExcel.
 * @param {Object} obj - Objeto a sanitizar
 * @returns {Object} Objeto sanitizado
 */
const sanitizeObjectForExcel = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
        return obj.map((item) => sanitizeObjectForExcel(item));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeForExcel(value);
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeObjectForExcel(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
};

module.exports = {
    sanitizeForExcel,
    sanitizeForPrompt,
    sanitizeObjectForExcel,
};
