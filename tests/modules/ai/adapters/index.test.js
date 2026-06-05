const { getAdapter, adapters } = require('../../../../src/modules/ai/adapters/index');
const GeminiAdapter = require('../../../../src/modules/ai/adapters/gemini.adapter');

describe('AI adapters registry', () => {
    const originalEnv = process.env.AI_PROVIDER;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        process.env.AI_PROVIDER = originalEnv;
    });

    test('expone gemini como provider soportado', () => {
        expect(adapters).toHaveProperty('gemini');
    });

    test('getAdapter("gemini") devuelve una instancia de GeminiAdapter', () => {
        const adapter = getAdapter('gemini');
        expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    test('getAdapter() sin args usa AI_PROVIDER del env', () => {
        process.env.AI_PROVIDER = 'gemini';
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    test('getAdapter() defaultea a "gemini" si AI_PROVIDER no está seteado', () => {
        delete process.env.AI_PROVIDER;
        const adapter = getAdapter();
        expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    test('getAdapter("provider-inexistente") lanza error con la lista de soportados', () => {
        expect(() => getAdapter('bedrock')).toThrow(/no soportado/);
        expect(() => getAdapter('bedrock')).toThrow(/gemini/);
    });
});