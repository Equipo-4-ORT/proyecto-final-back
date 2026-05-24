/**
 * Error tipado para indicar que un método abstracto no fue implementado
 * por la subclase. Permite que los consumers (controller, error handler)
 * distingan "el adapter no implementa esto" de otros errores en runtime.
 */
class AbstractMethodError extends Error {
    constructor(method) {
        super(`${method}() must be implemented by subclass`);
        this.name = 'AbstractMethodError';
        this.statusCode = 501;
    }
}


/**
 * Interfaz abstracta para el patrón Adapter de IA.
 * Define el contrato que TODOS los adapters (OpenAI, Gemini, Claude,
 * AWS Bedrock, etc.) deben cumplir.
 *
 * Las subclases heredan e implementan `generateSummary()` para convertir
 * actividades brutas en un reporte estructurado (AIModuleOutput).
 *
 * Diseño multi-tenant: este proyecto se distribuye a empresas que
 * eligen el proveedor de IA al desplegar. La selección se hace vía la
 * env var `AI_PROVIDER` y el registry en `adapters/index.js`. Por eso
 * NO hay validación de credenciales de ningún proveedor a nivel de
 * módulo — cada adapter valida sus propias credenciales en su
 * constructor, y solo se instancia el adapter elegido.
 *
 * Contrato que TODO adapter debe cumplir (sea OpenAI, Bedrock, Gemini):
 *   1. Validar sus propias credenciales en el constructor (fail-fast).
 *   2. Sanitizar inputs antes de mandarlos al modelo (los títulos de
 *      eventos, descripciones de Jira, etc. son contenido de usuario y
 *      pueden traer prompt-injection — "Ignore previous instructions...").
 *   3. Aislar instrucciones del sistema (rol del agente, formato esperado)
 *      del contenido de usuario. No interpolar datos en el system prompt.
 *   4. Validar el output recibido contra el contrato AIModuleOutput
 *      (ver ai.output.types.js). Si la IA devuelve algo que no cumple
 *      el schema, lanzar error tipado — nunca pasar garbage al consumer.
 *   5. Configurar timeouts y políticas de retry para no colgar requests.
 *   6. Sanitizar strings del output (formula injection en Excel — ver
 *      ai.output.types.js:67) antes de devolverlos.
 *
 * @abstract
 * @class AIAdapter
 *
 * @example
 * class OpenAIAdapter extends AIAdapter {
 *   async generateSummary(activities, userContext) {
 *     // implementación específica de OpenAI
 *     return { daySummary: "...", rows: [...], totalHours: 8 };
 *   }
 * }
 */
class AIAdapter {
    constructor() {
        if (new.target === AIAdapter) {
            throw new Error(
                'AIAdapter es abstracta — instanciá una subclase (ej: OpenAIAdapter, BedrockAdapter)'
            );
        }
    }

    /**
     * Genera un resumen ejecutivo y detallado de las actividades del día.
     *
     * @abstract
     * @async
     * @param {Array<Activity>} _activities - Array de actividades del día del usuario
     * @param {UserContext} _userContext - Contexto del usuario (nombre, rol, fecha)
     * @returns {Promise<AIModuleOutput>} Objeto con `daySummary`, `rows` y `totalHours`.
     * @throws {AbstractMethodError} Si la subclase no implementa el método.
     *
     * @example
     * const adapter = new OpenAIAdapter();
     * const output = await adapter.generateSummary(activities, userContext);
     * // output = { daySummary: "...", rows: [...], totalHours: 8 }
     */
    async generateSummary(_activities, _userContext) {
        throw new AbstractMethodError('generateSummary');
    }
}

module.exports = AIAdapter;
module.exports.AbstractMethodError = AbstractMethodError;
