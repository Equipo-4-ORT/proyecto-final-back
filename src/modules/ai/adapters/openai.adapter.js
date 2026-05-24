const OpenAI = require('openai');
const AIAdapter = require('../ai.interface');

/**
 * Adapter de OpenAI. Implementa la interfaz AIAdapter usando la API
 * oficial de OpenAI.
 *
 * Configuración: requiere `OPENAI_API_KEY` en el entorno. La validación
 * ocurre al construir la instancia (no al cargar el módulo), de modo
 * que las empresas que elijan otro provider (Bedrock, Gemini, etc.) no
 * necesiten tener seteada esta variable.
 */

let cachedClient = null;

const buildClient = () => {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error(
            'OPENAI_API_KEY environment variable is required when using OpenAIAdapter'
        );
    }
    return new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        // TODO: cuando se implemente generateSummary, fijar `timeout` y
        // `maxRetries` explícitos para que las llamadas no queden colgadas.
    });
};

const getDefaultClient = () => {
    if (!cachedClient) {
        cachedClient = buildClient();
    }
    return cachedClient;
};

class OpenAIAdapter extends AIAdapter {
    /**
     * @param {OpenAI} [client] - Cliente inyectable para testing. Si no se
     *   provee, se usa un singleton lazy compartido entre instancias.
     */
    constructor(client) {
        super();
        this.client = client || getDefaultClient();
    }

    /**
     * Genera un resumen usando OpenAI.
     * @async
     * @param {Array<Activity>} activities - Actividades del día
     * @param {UserContext} userContext - Contexto del usuario
     * @returns {Promise<AIModuleOutput>} Resumen estructurado
     */
    async generateSummary(_activities, _userContext) {
        // TODO antes de pasar a producción.
        //
        // PARTE GENÉRICA (vive en módulos compartidos, reusable por
        // CUALQUIER adapter — OpenAI, Bedrock, Gemini, etc.):
        //   - Sanitizar inputs antes de mandarlos al modelo. Los títulos
        //     de eventos / descripciones de Jira pueden contener prompt-
        //     injection ("Ignore previous instructions..."). Helper
        //     compartido: `ai.sanitize.js` (crear cuando se implemente
        //     el primer generateSummary).
        //   - Validar el output parseado contra el schema de
        //     `AIModuleOutput`. Schema compartido entre adapters:
        //     `ai.schemas.js` definido con Zod. Aclaración: Zod NO es
        //     una dep de OpenAI — es una librería genérica del proyecto,
        //     usada por todos los adapters para validar su output.
        //   - Sanitizar strings del output contra formula injection en
        //     Excel antes de devolver (ver `ai.output.types.js:67`).
        //     Helper compartido: `ai.sanitize.js`.
        //
        // PARTE ESPECÍFICA DE OPENAI (vive solo en este archivo):
        //   - Estructurar las messages como [{role:'system'},{role:'user'}]
        //     con instrucciones inmutables en system y datos en user.
        //   - Forzar el shape de salida con
        //     `response_format: { type: 'json_schema', schema: ... }`. El
        //     SDK trae `zodResponseFormat()` que convierte el schema Zod
        //     compartido al formato que pide OpenAI — esa es la única
        //     integración OpenAI↔Zod, no implica que Zod sea OpenAI-only.
        //   - Setear `max_tokens` para acotar costo y latencia.
        //   - Evaluar Zero Data Retention en la cuenta OpenAI si los
        //     datos de actividad son sensibles (privacidad / Ley 25.326).
        throw new Error('Not implemented yet');
    }
}

// Exportado solo para tests (reset entre casos que mutan OPENAI_API_KEY).
const _resetClientForTests = () => {
    cachedClient = null;
};

module.exports = OpenAIAdapter;
module.exports._resetClientForTests = _resetClientForTests;
