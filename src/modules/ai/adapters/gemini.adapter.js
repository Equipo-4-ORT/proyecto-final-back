const { GoogleGenerativeAI } = require('@google/generative-ai');
const AIAdapter = require('../ai.interface');
const { sanitizeForPrompt, sanitizeObjectForExcel } = require('../ai.sanitize');
const { validateAIModuleOutput, validateUserContext } = require('../ai.schemas');
const { generateSummaryPrompt } = require('../prompts/summary.prompt');
const { AIParseError, AIValidationError } = require('../ai.errors');

/**
 * Adapter de Gemini. Implementa la interfaz AIAdapter usando la API
 * de Google Generative AI.
 *
 * Configuración: requiere `GEMINI_API_KEY` en el entorno. La validación
 * ocurre al construir la instancia (no al cargar el módulo), de modo
 * que las empresas que elijan otro provider no necesiten setear esta var.
 */

// Presupuesto de tiempo: el worst case (REQUEST_TIMEOUT_MS * MAX_RETRIES +
// backoff + creación del Sheet) debe caber bajo el timeout del front (120s en
// reportsService.js). 45s * 2 ≈ 90s + Sheet ≈ 95s < 120s.
const REQUEST_TIMEOUT_MS = 45000; // 45 segundos por intento
const MAX_RETRIES = 2; // intentos totales (1 reintento)
const RETRY_BASE_DELAY_MS = 300;

let cachedClient = null;

const getDefaultClient = () => {
  if (!cachedClient) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required when using GeminiAdapter');
    }
    cachedClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return cachedClient;
};

/**
 * Decide si conviene reintentar un error de la API. Solo transitorios:
 * rate limit (429), 5xx, o errores de red sin status HTTP. Nunca 4xx
 * (config/credenciales) ni errores de parseo/validación (no son de red).
 */
const isRetriableError = (error) => {
  const status = error?.status ?? error?.response?.status;
  if (status === undefined) return true;
  return status === 429 || (status >= 500 && status < 600);
};

/**
 * Llama a generateContent con reintentos y backoff lineal para errores
 * transitorios. Equivale al `maxRetries` que OpenAI trae de fábrica.
 */
const generateContentWithRetries = async (model, prompt) => {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES || !isRetriableError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
    }
  }
  throw lastError;
};

class GeminiAdapter extends AIAdapter {
  /**
   * @param {GoogleGenerativeAI} [client] - Cliente inyectable para testing.
   */
  constructor(client) {
    super();
    this.genAI = client || getDefaultClient();
    this.model = this.genAI.getGenerativeModel(
      {
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          // gemini-2.5-flash activa "thinking" por defecto, lo que agrega
          // latencia y hacía que la respuesta superara REQUEST_TIMEOUT_MS y se
          // abortara. Para esta tarea (extracción/resumen JSON estructurado) el
          // razonamiento extendido no aporta, así que lo desactivamos.
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
  }

  async generateSummary(activities, userContext) {
    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      throw new Error('Activities array cannot be empty', { cause: new Error('Invalid input') });
    }
    if (!userContext) {
      throw new Error('UserContext is required', { cause: new Error('Invalid input') });
    }

    // Valida el shape del contexto (name/role no vacíos, date string|Date).
    // Lanza AIValidationError si no cumple.
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

    const { fullPrompt } = generateSummaryPrompt(sanitizedActivities, sanitizedContext);

    try {
      const result = await generateContentWithRetries(this.model, fullPrompt);
      const responseText = result.response.text();

      let parsedOutput;
      try {
        parsedOutput = JSON.parse(responseText);
      } catch (parseError) {
        throw new AIParseError(`Invalid JSON from Gemini: ${parseError.message}`, {
          cause: parseError,
        });
      }

      // Mismas validaciones estrictas que usamos en OpenAI.
      const validatedOutput = validateAIModuleOutput(parsedOutput);
      return sanitizeObjectForExcel(validatedOutput);
    } catch (error) {
      // Los errores de parseo/validación ya vienen tipados y con mensaje
      // útil: los dejamos pasar tal cual en vez de disfrazarlos de error
      // de API. Solo lo que no reconocemos se trata como fallo de la API.
      if (error instanceof AIParseError || error instanceof AIValidationError) {
        throw error;
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
