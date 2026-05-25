/**
 * Sanitización de strings para prevenir formula injection en Excel
 * y prompt injection en llamadas a la IA.
 *
 * Formula injection: Si un string comienza con =, +, -, o @,
 * Excel lo interpreta como fórmula. Escapamos con apóstrofo.
 *
 * Prompt injection: Si el contenido del usuario contiene instrucciones
 * (ej: "Ignore previous instructions..."), puede manipular la IA.
 * Sanitizamos removiendo caracteres peligrosos.
 */

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
 * Sanitiza un string para prevenir prompt injection.
 * Remueve caracteres de control y limita caracteres especiales peligrosos.
 * @param {string} str - String a sanitizar
 * @returns {string} String sanitizado
 */
const sanitizeForPrompt = (str) => {
    if (!str || typeof str !== 'string') return str;
    // Remover caracteres de control usando codePointAt instead of regex
    let sanitized = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // Permitir: printable ASCII (32-126), tab (9), newline (10), carriage return (13)
        if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
            sanitized += str[i];
        }
    }
    return sanitized.trim();
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