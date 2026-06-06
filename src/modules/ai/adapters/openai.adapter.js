const OpenAI = require('openai');
const AIAdapter = require('../ai.interface');
const { sanitizeForPrompt, sanitizeObjectForExcel } = require('../ai.sanitize');
const { validateAIModuleOutput, validateUserContext } = require('../ai.schemas');
const { generateSummaryPrompt } = require('../prompts/summary.prompt');

/**
 * Adapter de OpenAI. Implementa la interfaz AIAdapter usando la API
 * oficial de OpenAI.
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
    constructor(client) {
        super();
        this.client = client || getDefaultClient();
    }

    async generateSummary(activities, userContext) {
        if (!activities || !Array.isArray(activities) || activities.length === 0) {
            throw new Error('Activities array cannot be empty', { cause: new Error('Invalid input') });
        }

        if (!userContext) {
            throw new Error('UserContext is required', { cause: new Error('Invalid input') });
        }

        // Validación de contexto que vino de develop
        const validatedContext = validateUserContext(userContext);

        const sanitizedActivities = activities.map((activity) => ({
            ...activity,
            metadata: {
                ...activity.metadata,
                title: sanitizeForPrompt(activity.metadata?.title || ''),
                description: sanitizeForPrompt(activity.metadata?.description || ''),
            },
        }));
        const sanitizedContext = {
            ...validatedContext,
            name: sanitizeForPrompt(validatedContext.name),
            role: sanitizeForPrompt(validatedContext.role),
        };

        // Tu prompt extraído usando el contexto validado
        const { systemPrompt, userPrompt } = generateSummaryPrompt(sanitizedActivities, sanitizedContext);

        try {
            const response = await this.client.chat.completions.create({
                model: 'gpt-4o-mini',
                max_tokens: 2048,
                temperature: 0.2,
                response_format: { type: 'json_object' },
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

            if (!responseText) {
                throw new Error('Empty content from OpenAI', { cause: new Error('API response validation failed') });
            }

            // Fallback defensivo que vino de develop
            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : responseText;

            let parsedOutput;
            try {
                parsedOutput = JSON.parse(jsonStr);
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

            if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
                throw new Error(`OpenAI request timeout: ${error.message}`, { cause: error });
            }

            throw error;
        }
    }
}

const _resetClientForTests = () => {
    cachedClient = null;
};

module.exports = OpenAIAdapter;
module.exports._resetClientForTests = _resetClientForTests;