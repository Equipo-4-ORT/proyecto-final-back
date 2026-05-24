const { getAdapter, adapters } = require('../../../../src/modules/ai/adapters');
const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

describe('AI adapters registry', () => {
    const originalEnv = process.env.OPENAI_API_KEY;
    const originalProvider = process.env.AI_PROVIDER;

    beforeEach(() => {
        OpenAIAdapter._resetClientForTests();
        process.env.OPENAI_API_KEY = 'test-key';
    });

    afterAll(() => {
        if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalEnv;

        if (originalProvider === undefined) delete process.env.AI_PROVIDER;
        else process.env.AI_PROVIDER = originalProvider;

        OpenAIAdapter._resetClientForTests();
    });

    test('expone openai como provider soportado', () => {
        expect(adapters).toHaveProperty('openai');
    });

    test('getAdapter("openai") devuelve una instancia de OpenAIAdapter', () => {
        const adapter = getAdapter('openai');
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('getAdapter() sin args usa AI_PROVIDER del env', () => {
        process.env.AI_PROVIDER = 'openai';
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('getAdapter() defaultea a "openai" si AI_PROVIDER no está seteado', () => {
        delete process.env.AI_PROVIDER;
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('getAdapter("provider-inexistente") lanza error con la lista de soportados', () => {
        expect(() => getAdapter('bedrock')).toThrow(/no soportado/);
        expect(() => getAdapter('bedrock')).toThrow(/openai/);
    });
});
