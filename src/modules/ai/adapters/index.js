const OpenAIAdapter = require('./openai.adapter');

/**
 * Registry de adapters de IA disponibles. La empresa que despliegue
 * elige el provider vía la env var `AI_PROVIDER` (default: 'openai').
 *
 * Cada provider valida sus propias credenciales recién al instanciarse,
 * así que las empresas que usen otro provider (ej. Bedrock) no necesitan
 * tener seteada la API key de OpenAI.
 *
 * Para agregar un nuevo adapter:
 *   1. Crear `src/modules/ai/adapters/<provider>.adapter.js` extendiendo AIAdapter.
 *   2. Registrarlo en el mapa `adapters` de abajo.
 *   3. Documentar la env var del provider en `.env.example`.
 */

const adapters = {
    openai: OpenAIAdapter,
};

const getAdapter = (provider = process.env.AI_PROVIDER || 'openai') => {
    const Adapter = adapters[provider];
    if (!Adapter) {
        const supported = Object.keys(adapters).join(', ');
        throw new Error(`AI provider "${provider}" no soportado. Soportados: ${supported}`);
    }
    return new Adapter();
};

module.exports = {
    getAdapter,
    adapters,
};
