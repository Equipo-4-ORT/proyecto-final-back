const GeminiAdapter = require('../../../../src/modules/ai/adapters/gemini.adapter');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Mockeamos la librería de Google
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => {
    return {
        GoogleGenerativeAI: jest.fn().mockImplementation(() => {
            return {
                getGenerativeModel: jest.fn().mockReturnValue({
                    generateContent: mockGenerateContent
                })
            };
        })
    };
});

describe('GeminiAdapter (Unit Tests)', () => {
    const originalEnv = process.env.GEMINI_API_KEY;

    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-api-key';
        jest.clearAllMocks();
        GeminiAdapter._resetClientForTests();
    });

    afterAll(() => {
        process.env.GEMINI_API_KEY = originalEnv;
    });

    test('Lanza error si no hay GEMINI_API_KEY en el entorno', () => {
        delete process.env.GEMINI_API_KEY;
        expect(() => new GeminiAdapter()).toThrow(/GEMINI_API_KEY environment variable is required/);
    });

    test('generateSummary formatea y devuelve el JSON correctamente', async () => {
        const adapter = new GeminiAdapter();
        const mockActivities = [{ id: '1', metadata: { title: 'Test Activity', activityType: 'meeting' } }];
        const userContext = { name: 'Santiago Portelli', role: 'BI Analyst', date: '2026-06-05' };

        // Simulamos que Gemini responde con un JSON válido
        mockGenerateContent.mockResolvedValue({
            response: {
                text: () => JSON.stringify({
                    daySummary: "Resumen de prueba",
                    rows: [
                        {
                            date: "2026-06-05",
                            startTime: "09:00",
                            endTime: "10:00",
                            duration: 60,
                            source: "calendar",
                            app: "Meet",
                            activityType: "meeting",
                            title: "Test Activity",
                            description: "Test description",
                            summary: "Test summary"
                        }
                    ],
                    totalHours: 1
                })
            }
        });

        const result = await adapter.generateSummary(mockActivities, userContext);
        
        expect(result).toHaveProperty('daySummary', 'Resumen de prueba');
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    test('generateSummary lanza error si Gemini devuelve JSON inválido', async () => {
        const adapter = new GeminiAdapter();
        const mockActivities = [{ id: '1', metadata: { title: 'Test' } }];
        const userContext = { name: 'Santiago', role: 'Dev', date: '2026-06-05' };

        // Simulamos que Gemini alucina y devuelve texto roto
        mockGenerateContent.mockResolvedValue({
            response: {
                text: () => "Esto no es un JSON { roto"
            }
        });

        await expect(adapter.generateSummary(mockActivities, userContext))
            .rejects.toThrow(/Invalid JSON from Gemini/);
    });
});