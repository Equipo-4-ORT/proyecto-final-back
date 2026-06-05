const { GoogleGenerativeAI } = require("@google/generative-ai")
const AIAdapter = require("../ai.interface");

let cachedClient = null;

const getDefaultClient = () => {
    if (!cachedClient) {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY environment variable is required when using GeminiAdapter')
        }
        cachedClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return cachedClient;
}

class GeminiAdapter extends AIAdapter {
    constructor(client) {
        super();
        this.genAI = client || getDefaultClient();
        this.model = this.genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.2
            }
        });
    }
    async generateSummary(activities, userContext) {
        const { sanitizeForPrompt, sanitizeObjectForExcel } = require('../ai.sanitize');
        const { validateAIModuleOutput } = require('../ai.schemas')
        const { generateSummaryPrompt } = require('../prompts/summary.prompt')

        if (!activities || !Array.isArray(activities) || activities.length === 0) {
            throw Error('Activities array cannot be empty', { cause: new Error('Invalid input') })
        }
        if (!userContext) {
            throw new Error('UserContext is required', { cause: Error('Invalid input') })
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
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

        try {
            const result = await this.model.generateContent(fullPrompt);
            const responseText = result.response.text();
            
            let parsedOutput;
            try {
                parsedOutput = JSON.parse(responseText);
            } catch (parseError) {
                throw new Error(`Invalid JSON from Gemini: ${parseError.message}`, { cause: parseError });
            }

            // Mismas validaciones estrictas que usamos en OpenAI
            const validatedOutput = validateAIModuleOutput(parsedOutput);
            const sanitizedOutput = sanitizeObjectForExcel(validatedOutput);

            return sanitizedOutput;

        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error('Gemini returned invalid JSON', { cause: error });
            }
            throw new Error(`Gemini API error: ${error.message}`, { cause: error });
        }
    }
}

const _resetClientForTests = () => {
    cachedClient = null;
};

module.exports = GeminiAdapter;
module.exports._resetClientForTests = _resetClientForTests;