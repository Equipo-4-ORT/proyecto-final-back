const OpenAI = require('openai')
const AIAdapter = require('../ai.interface')

/**
 * Adapter para OpenAI
 * Implementa la interfaz AIAdapter usando la API de OpenAI.
 */

class OpenAIAdapter extends AIAdapter {
    constructor() {
        super();
        this.client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        })
    }

    /**
     * Generar un resumen usando OpenAI.
     * @async
     * @param {Array<Activity>} activities - Actividad del dia
     * @param {UserContext} userContext - Contexto del usuario
     * @returns {Promise<AIModuleOutput>} - Resumen estructurado
     */
    async generateSummary(activities, userContext) {
        // TODO: Implementar logica de OpenAI
        throw new Error('Not implemented yet');
    }
}

module.exports = OpenAIAdapter;