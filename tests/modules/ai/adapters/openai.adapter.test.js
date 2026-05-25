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

        test('generateSummary valida que activities no esté vacío', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        await expect(adapter.generateSummary([], {})).rejects.toThrow('Activities array cannot be empty');
    });

    test('generateSummary valida que userContext esté presente', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        const adapter = new OpenAIAdapter();
        const mockActivities = [
            {
                id: 'act1',
                source: 'calendar',
                activityType: 'meeting',
                startTime: new Date('2026-05-25T09:00:00Z'),
                endTime: new Date('2026-05-25T10:00:00Z'),
                metadata: { title: 'Daily standup' },
            },
        ];
        await expect(adapter.generateSummary(mockActivities, null)).rejects.toThrow('UserContext is required');
    });

    test('generateSummary llama a OpenAI API con formato correcto', async () => {
        process.env.OPENAI_API_KEY = 'test-key';
        
        const mockResponse = {
            choices: [
                {
                    message: {
                        content: JSON.stringify({
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
                        }),
                    },
                },
            ],
        };

        const mockClient = {
            chat: {
                completions: {
                    create: jest.fn().mockResolvedValue(mockResponse),
                },
            },
        };

        const adapter = new OpenAIAdapter(mockClient);
        const result = await adapter.generateSummary(
            [
                {
                    id: 'act1',
                    source: 'calendar',
                    activityType: 'meeting',
                    startTime: new Date('2026-05-25T09:00:00Z'),
                    endTime: new Date('2026-05-25T10:00:00Z'),
                    metadata: { title: 'Daily standup' },
                },
            ],
            { name: 'Juan Perez', role: 'employee', date: '2026-05-25' }
        );

        expect(result).toEqual(expect.objectContaining({
            daySummary: expect.any(String),
            rows: expect.any(Array),
            totalHours: expect.any(Number),
        }));
        expect(mockClient.chat.completions.create).toHaveBeenCalled();
    });

    test('generateSummary lanza error si la respuesta de OpenAI no es JSON válido', async () => {
        process.env.OPENAI_API_KEY = 'test-key';

        const mockClient = {
            chat: {
                completions: {
                    create: jest.fn().mockResolvedValue({
                        choices: [{ message: { content: 'invalid json {' } }],
                    }),
                },
            },
        };

        const adapter = new OpenAIAdapter(mockClient);
        await expect(
            adapter.generateSummary(
                [
                    {
                        id: 'act1',
                        source: 'calendar',
                        activityType: 'meeting',
                        startTime: new Date('2026-05-25T09:00:00Z'),
                        endTime: new Date('2026-05-25T10:00:00Z'),
                        metadata: { title: 'Test' },
                    },
                ],
                { name: 'Juan', role: 'employee', date: '2026-05-25' }
            )
        ).rejects.toThrow(/Invalid JSON/);
    });

    test('generateSummary maneja errores de rate limit (429)', async () => {
        process.env.OPENAI_API_KEY = 'test-key';

        const mockError = new Error('Rate limited');
        mockError.status = 429;

        const mockClient = {
            chat: {
                completions: {
                    create: jest.fn().mockRejectedValue(mockError),
                },
            },
        };

        const adapter = new OpenAIAdapter(mockClient);
        await expect(
            adapter.generateSummary(
                [
                    {
                        id: 'act1',
                        source: 'calendar',
                        activityType: 'meeting',
                        startTime: new Date('2026-05-25T09:00:00Z'),
                        endTime: new Date('2026-05-25T10:00:00Z'),
                        metadata: { title: 'Test' },
                    },
                ],
                { name: 'Juan', role: 'employee', date: '2026-05-25' }
            )
        ).rejects.toThrow(/rate limit/i);
    });
});
