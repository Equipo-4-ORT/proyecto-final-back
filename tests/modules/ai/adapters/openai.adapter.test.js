const AIAdapter = require('../../../../src/modules/ai/ai.interface');
const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

describe('OpenAIAdapter', () => {
    const originalEnv = process.env.OPENAI_API_KEY;

    beforeEach(() => {
        OpenAIAdapter._resetClientForTests();
    });

    afterAll(() => {
        if (originalEnv === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = originalEnv;
        }
        OpenAIAdapter._resetClientForTests();
    });

    test('extiende AIAdapter (cumple el contrato)', () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        expect(adapter).toBeInstanceOf(AIAdapter);
    });

    test('el constructor lanza si falta OPENAI_API_KEY', () => {
        delete process.env.OPENAI_API_KEY;
        expect(() => new OpenAIAdapter()).toThrow(/OPENAI_API_KEY/);
    });

    test('el constructor lanza si OPENAI_API_KEY está vacía', () => {
        process.env.OPENAI_API_KEY = '';
        expect(() => new OpenAIAdapter()).toThrow(/OPENAI_API_KEY/);
    });

    test('acepta un cliente inyectado para testing sin tocar el env', () => {
        delete process.env.OPENAI_API_KEY;
        const mockClient = { chat: { completions: { create: jest.fn() } } };
        const adapter = new OpenAIAdapter(mockClient);
        expect(adapter.client).toBe(mockClient);
    });

    test('varias instancias comparten el mismo cliente singleton (no se crea un client por instancia)', () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const a = new OpenAIAdapter();
        const b = new OpenAIAdapter();
        expect(a.client).toBe(b.client);
    });

    test('generateSummary todavía no está implementado — lanza Not implemented yet', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        await expect(adapter.generateSummary([], {})).rejects.toThrow('Not implemented yet');
    });
});
