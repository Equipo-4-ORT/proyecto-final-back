const { getAdapter, adapters } = require('../../../../src/modules/ai/adapters/index');
const GeminiAdapter = require('../../../../src/modules/ai/adapters/gemini.adapter');
const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

// Inyectamos llaves dummy para que GitHub Actions no explote al instanciar los adaptadores
process.env.GEMINI_API_KEY = 'dummy-test-key';
process.env.OPENAI_API_KEY = 'dummy-test-key';

describe('AI adapters registry', () => {
    const originalEnv = process.env.AI_PROVIDER;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        process.env.AI_PROVIDER = originalEnv;
    });

    test('expone gemini y openai como providers soportados', () => {
        expect(adapters).toHaveProperty('gemini');
        expect(adapters).toHaveProperty('openai');
    });

    test('getAdapter("gemini") devuelve una instancia de GeminiAdapter', () => {
        const adapter = getAdapter('gemini');
        expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    test('getAdapter("openai") sigue devolviendo una instancia de OpenAIAdapter', () => {
        const adapter = getAdapter('openai');
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('getAdapter() sin args usa AI_PROVIDER del env', () => {
        process.env.AI_PROVIDER = 'openai';
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('getAdapter() defaultea a "gemini" si AI_PROVIDER no está seteado', () => {
        delete process.env.AI_PROVIDER;
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    test('getAdapter("provider-inexistente") lanza error con la lista de soportados', () => {
        expect(() => getAdapter('bedrock')).toThrow(/no soportado/);
        expect(() => getAdapter('bedrock')).toThrow(/openai/);
        expect(() => getAdapter('bedrock')).toThrow(/gemini/);
    });
});
