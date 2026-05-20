/**
 * Configuración centralizada de la aplicación.
 * Los módulos deben importar desde aquí en vez de leer process.env directamente.
 * Nota: jira.constants.js tiene su propia config con validación requireEnv;
 * migrarla acá es el siguiente paso de refactor.
 */
module.exports = {
    get frontendBaseUrl() { return process.env.FRONTEND_BASE_URL; },
    get port() { return Number(process.env.PORT) || 3000; },
    get nodeEnv() { return process.env.NODE_ENV || 'development'; },
};
