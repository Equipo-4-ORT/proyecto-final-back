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
        timeout: 30000,
        maxRetries: 3,
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
    async generateSummary(activities, userContext) {
        const { sanitizeForPrompt, sanitizeObjectForExcel } = require('../ai.sanitize');
        const { validateAIModuleOutput } = require('../ai.schemas');
        const { generateSummaryPrompt } = require('../prompts/summary.prompt');

        if (!activities || !Array.isArray(activities) || activities.length === 0) {
            throw new Error('Activities array cannot be empty', { cause: new Error('Invalid input') });
        }

        if (!userContext) {
            throw new Error('UserContext is required', { cause: new Error('Invalid input') });
        }

        const sanitizedActivities = activities.map((activity) => ({
            ...activity,
            metadata: {
                ...activity.metadata,
                title: sanitizeForPrompt(activity.metadata?.title || ''),
                description: sanitizeForPrompt(activity.metadata?.description || ''),
            },
        }));

        const { systemPrompt, userPrompt } = generateSummaryPrompt(sanitizedActivities, userContext);

        try {
            const response = await this.client.chat.completions.create({
                model: 'gpt-4o-mini',
                max_tokens: 2048,
                temperature: 0.2,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt,
                    },
                    {
                        role: 'user',
                        content: userPrompt,
                    },
                ],
            });

            if (!response.choices || response.choices.length === 0) {
                throw new Error('Empty response from OpenAI', { cause: new Error('API response validation failed') });
            }

            const responseText = response.choices[0].message.content;

            let parsedOutput;
            try {
                parsedOutput = JSON.parse(responseText);
            } catch (parseError) {
                throw new Error(`Invalid JSON from OpenAI: ${parseError.message}`, { cause: parseError });
            }

            const validatedOutput = validateAIModuleOutput(parsedOutput);
            const sanitizedOutput = sanitizeObjectForExcel(validatedOutput);

            return sanitizedOutput;
        } catch (error) {
            if (error.status === 429) {
                throw new Error(`OpenAI rate limit exceeded: ${error.message}`, { cause: error });
            }

            if (error.status === 401 || error.status === 403) {
                throw new Error(`OpenAI authentication failed: Invalid API key`, { cause: error });
            }

            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                throw new Error(`OpenAI request timeout: ${error.message}`, { cause: error });
            }

            throw error;
        }
    }
}

// Exportado solo para tests (reset entre casos que mutan OPENAI_API_KEY).
const _resetClientForTests = () => {
    cachedClient = null;
};

module.exports = OpenAIAdapter;
module.exports._resetClientForTests = _resetClientForTests;
