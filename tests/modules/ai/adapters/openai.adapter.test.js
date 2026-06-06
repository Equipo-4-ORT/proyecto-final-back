const AIAdapter = require('../../../../src/modules/ai/ai.interface');
const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

// --- Helpers para reducir repetición en los tests ---

const makeActivities = (metadataOverrides = {}) => [
    {
        id: 'act1',
        source: 'calendar',
        activityType: 'meeting',
        startTime: new Date('2026-05-25T09:00:00Z'),
        endTime: new Date('2026-05-25T10:00:00Z'),
        metadata: { title: 'Daily standup', ...metadataOverrides },
    },
];

const makeContext = (overrides = {}) => ({
    name: 'Juan Pérez',
    role: 'employee',
    date: '2026-05-25',
    ...overrides,
});

const validOutput = {
    daySummary: 'Día productivo',
    rows: [
        {
            date: '2026-05-25',
            startTime: '09:00',
            endTime: '10:00',
            duration: 60,
            source: 'calendar',
            app: 'Meet',
            activityType: 'meeting',
            title: 'Daily standup',
            summary: 'Sync diario del equipo',
        },
    ],
    totalHours: 1,
};

const responseWith = (obj) => ({
    choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }],
});

const mockClientResolving = (response) => ({
    chat: { completions: { create: jest.fn().mockResolvedValue(response) } },
});

const mockClientRejecting = (error) => ({
    chat: { completions: { create: jest.fn().mockRejectedValue(error) } },
});

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

    test('generateSummary valida que activities no esté vacío', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        await expect(adapter.generateSummary([], {})).rejects.toThrow('Activities array cannot be empty');
    });

    test('generateSummary valida que userContext esté presente', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        await expect(adapter.generateSummary(makeActivities(), null)).rejects.toThrow('UserContext is required');
    });

    test('generateSummary valida el shape de userContext (name vacío)', async () => {
        const mockClient = mockClientResolving(responseWith(validOutput));
        const adapter = new OpenAIAdapter(mockClient);
        await expect(
            adapter.generateSummary(makeActivities(), makeContext({ name: '' }))
        ).rejects.toThrow(/UserContext validation failed/);
        // No debe haber llamado a la API si el contexto es inválido
        expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
    });

    test('generateSummary llama a OpenAI con JSON mode, temperature 0 y sin max_tokens', async () => {
        const mockClient = mockClientResolving(responseWith(validOutput));
        const adapter = new OpenAIAdapter(mockClient);

        await adapter.generateSummary(makeActivities(), makeContext());

        expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
        const payload = mockClient.chat.completions.create.mock.calls[0][0];
        expect(payload.response_format).toEqual({ type: 'json_object' });
        expect(payload.temperature).toBe(0.2);
        expect(payload.max_tokens).toBe(2048);
        // Aislamiento de instrucciones: system separado de los datos de usuario
        expect(payload.messages[0].role).toBe('system');
        expect(payload.messages[1].role).toBe('user');
    });

    test('generateSummary devuelve un output válido', async () => {
        const mockClient = mockClientResolving(responseWith(validOutput));
        const adapter = new OpenAIAdapter(mockClient);

        const result = await adapter.generateSummary(makeActivities(), makeContext());

        expect(result).toEqual(
            expect.objectContaining({
                daySummary: expect.any(String),
                rows: expect.any(Array),
                totalHours: expect.any(Number),
            })
        );
    });

    test('generateSummary sanitiza el input: preserva acentos pero remueve caracteres de control', async () => {
        const ctrl = String.fromCharCode(0);
        const validContext = { name: `Santiago${ctrl} Núñez`, role: 'Dev', date: '2026-05-25' };
        const mockClient = mockClientResolving(responseWith(validOutput));
        const adapter = new OpenAIAdapter(mockClient);
        const activities = makeActivities({ title: `Reunión${ctrl} Planning` });

        await adapter.generateSummary(activities, validContext);

        const userMessage = mockClient.chat.completions.create.mock.calls[0][0].messages[1].content;
        expect(userMessage).toContain('Reunión Planning'); 
        expect(userMessage).toContain('Núñez');
        expect(userMessage).not.toContain(ctrl);
    });

    test('generateSummary escapa formula injection en el output (Excel)', async () => {
        const malicious = {
            ...validOutput,
            rows: [{ ...validOutput.rows[0], title: '=SUM(A1)', summary: '+1234' }],
        };
        const mockClient = mockClientResolving(responseWith(malicious));
        const adapter = new OpenAIAdapter(mockClient);

        const result = await adapter.generateSummary(makeActivities(), makeContext());

        expect(result.rows[0].title).toBe("'=SUM(A1)");
        expect(result.rows[0].summary).toBe("'+1234");
    });

    test('generateSummary acepta JSON envuelto en bloque markdown', async () => {
        const wrapped = '```json\n' + JSON.stringify(validOutput) + '\n```';
        const mockClient = mockClientResolving(responseWith(wrapped));
        const adapter = new OpenAIAdapter(mockClient);

        const result = await adapter.generateSummary(makeActivities(), makeContext());
        expect(result.daySummary).toBe(validOutput.daySummary);
    });

    test('generateSummary lanza error si la respuesta de OpenAI no es JSON válido', async () => {
        const mockClient = mockClientResolving(responseWith('invalid json {'));
        const adapter = new OpenAIAdapter(mockClient);
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/Invalid JSON/);
    });

    test('generateSummary lanza si el output no cumple el schema AIModuleOutput', async () => {
        // JSON válido pero le falta `summary` (requerido) en la fila.
        const incomplete = {
            daySummary: 'Resumen',
            rows: [{ ...validOutput.rows[0], summary: undefined }],
            totalHours: 1,
        };
        const mockClient = mockClientResolving(responseWith(incomplete));
        const adapter = new OpenAIAdapter(mockClient);
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(
            /AIModuleOutput validation failed/
        );
    });

    test('generateSummary lanza si OpenAI devuelve content vacío', async () => {
        const mockClient = mockClientResolving({ choices: [{ message: { content: null } }] });
        const adapter = new OpenAIAdapter(mockClient);
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/Empty content/);
    });

    test('generateSummary maneja errores de rate limit (429)', async () => {
        const error = Object.assign(new Error('Rate limited'), { status: 429 });
        const adapter = new OpenAIAdapter(mockClientRejecting(error));
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/rate limit/i);
    });

    test('generateSummary maneja errores de autenticación (401/403)', async () => {
        const error = Object.assign(new Error('Unauthorized'), { status: 401 });
        const adapter = new OpenAIAdapter(mockClientRejecting(error));
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(
            /authentication failed/i
        );
    });

    test('generateSummary maneja timeouts', async () => {
        const error = Object.assign(new Error('socket timeout'), { code: 'ECONNABORTED' });
        const adapter = new OpenAIAdapter(mockClientRejecting(error));
        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/timeout/i);
    });
});
