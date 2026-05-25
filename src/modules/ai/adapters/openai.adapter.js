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
        timeout: 30000, // 30 segundos
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

        if (!activities || !Array.isArray(activities) || activities.length === 0) {
            throw new Error('Activities array cannot be empty');
        }

        if (!userContext) {
            throw new Error('UserContext is required');
        }

        const sanitizedActivities = activities.map((activity) => ({
            ...activity,
            metadata: {
                ...activity.metadata,
                title: sanitizeForPrompt(activity.metadata?.title || ''),
                description: sanitizeForPrompt(activity.metadata?.description || ''),
            },
        }));

        const systemPrompt = `You are an AI assistant that summarizes work activities into a structured daily report.

Your task is to:
1. Analyze a list of activities from a user's workday
2. Group related activities by time and application
3. Generate a professional executive summary
4. Return a JSON object with the exact structure specified below

IMPORTANT:
- All times must be in HH:mm format (24-hour)
- Duration must be in minutes (integer)
- All strings must be sanitized (no formula injection chars: =, +, -, @)
- Return ONLY valid JSON, no additional text
- Dates must be in YYYY-MM-DD format

Expected JSON structure:
{
  "daySummary": "2-3 sentence executive summary of the entire day",
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "duration": <number in minutes>,
      "source": "calendar|drive|jira",
      "app": "Meet|Docs|Sheets|Drive|Jira|...",
      "activityType": "meeting|edit|transition|...",
      "title": "activity title",
      "description": "optional description",
      "summary": "brief summary of what was done"
    }
  ],
  "totalHours": <number of total hours worked>
}`;

        const userPrompt = `User: ${sanitizeForPrompt(userContext.name)}
Role: ${sanitizeForPrompt(userContext.role)}
Date: ${userContext.date instanceof Date ? userContext.date.toISOString().split('T')[0] : userContext.date}

Activities:
${JSON.stringify(sanitizedActivities, null, 2)}

Please generate the daily report summary.`;

        try {
            const response = await this.client.chat.completions.create({
                model: 'gpt-4o-mini',
                max_tokens: 2048,
                temperature: 0.7,
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
                throw new Error('Empty response from OpenAI');
            }

            const responseText = response.choices[0].message.content;

            // Intentar extraer JSON si está envuelto en markdown
            let jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
            let jsonStr = jsonMatch ? jsonMatch[1] : responseText;

            let parsedOutput;
            try {
                parsedOutput = JSON.parse(jsonStr);
            } catch (parseError) {
                throw new Error(`Invalid JSON from OpenAI: ${parseError.message}`);
            }

            const validatedOutput = validateAIModuleOutput(parsedOutput);

            const sanitizedOutput = sanitizeObjectForExcel(validatedOutput);

            return sanitizedOutput;
        } catch (error) {

            if (error.status === 429) {
                throw new Error(`OpenAI rate limit exceeded: ${error.message}`);
            }

            if (error.status === 401 || error.status === 403) {
                throw new Error(`OpenAI authentication failed: Invalid API key`);
            }

            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                throw new Error(`OpenAI request timeout: ${error.message}`);
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
