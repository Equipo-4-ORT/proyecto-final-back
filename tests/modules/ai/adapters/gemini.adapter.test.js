const GeminiAdapter = require('../../../../src/modules/ai/adapters/gemini.adapter');

// Mockeamos la librería de Google. getGenerativeModel devuelve siempre el
// mismo objeto con nuestro mock de generateContent.
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => {
    return {
        GoogleGenerativeAI: jest.fn().mockImplementation(() => {
            return {
                getGenerativeModel: jest.fn().mockReturnValue({
                    generateContent: mockGenerateContent,
                }),
            };
        }),
    };
});

// --- Helpers ---

const validOutput = {
    daySummary: 'Resumen de prueba',
    rows: [
        {
            date: '2026-06-05',
            startTime: '09:00',
            endTime: '10:00',
            duration: 60,
            source: 'calendar',
            app: 'Meet',
            activityType: 'meeting',
            title: 'Test Activity',
            description: 'Test description',
            summary: 'Test summary',
        },
    ],
    totalHours: 1,
};

const responseWith = (obj) => ({
    response: { text: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) },
});

const makeActivities = () => [{ id: '1', metadata: { title: 'Test Activity', activityType: 'meeting' } }];
const makeContext = (overrides = {}) => ({
    name: 'Santiago Portelli',
    role: 'BI Analyst',
    date: '2026-06-05',
    ...overrides,
});

describe('GeminiAdapter (Unit Tests)', () => {
    const originalEnv = process.env.GEMINI_API_KEY;

    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-api-key';
        // mockReset limpia impl y cola de *Once entre tests (evita filtración).
        mockGenerateContent.mockReset();
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
        mockGenerateContent.mockResolvedValue(responseWith(validOutput));

        const result = await adapter.generateSummary(makeActivities(), makeContext());

        expect(result).toHaveProperty('daySummary', 'Resumen de prueba');
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    test('generateSummary lanza error si Gemini devuelve JSON inválido', async () => {
        const adapter = new GeminiAdapter();
        mockGenerateContent.mockResolvedValue(responseWith('Esto no es un JSON { roto'));

        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(
            /Invalid JSON from Gemini/
        );
    });

    test('valida el shape de userContext y NO llama a la API si es inválido', async () => {
        const adapter = new GeminiAdapter();
        await expect(
            adapter.generateSummary(makeActivities(), makeContext({ name: '' }))
        ).rejects.toThrow(/UserContext validation failed/);
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    test('sanitiza name/role del contexto antes de mandarlos al prompt', async () => {
        const adapter = new GeminiAdapter();
        mockGenerateContent.mockResolvedValue(responseWith(validOutput));
        const ctrl = String.fromCharCode(0); // NUL (carácter de control)

        await adapter.generateSummary(
            makeActivities(),
            makeContext({ name: `Santi${ctrl} Núñez`, role: `Dev${ctrl}` })
        );

        const promptSent = mockGenerateContent.mock.calls[0][0];
        expect(promptSent).toContain('Santi Núñez'); // acento intacto, control removido
        expect(promptSent).not.toContain(ctrl);
    });

    test('lanza si el output no cumple el schema AIModuleOutput', async () => {
        const adapter = new GeminiAdapter();
        const incomplete = { ...validOutput, rows: [{ ...validOutput.rows[0], summary: undefined }] };
        mockGenerateContent.mockResolvedValue(responseWith(incomplete));

        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(
            /AIModuleOutput validation failed/
        );
    });

    test('reporta error de API no transitorio (401) sin reintentar', async () => {
        const adapter = new GeminiAdapter();
        mockGenerateContent.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/Gemini API error/);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    test('reintenta una vez ante un error transitorio y luego resuelve', async () => {
        const adapter = new GeminiAdapter();
        mockGenerateContent
            .mockRejectedValueOnce(new Error('socket hang up')) // sin status HTTP → error de red
            .mockResolvedValueOnce(responseWith(validOutput));

        const result = await adapter.generateSummary(makeActivities(), makeContext());

        expect(result).toHaveProperty('daySummary', 'Resumen de prueba');
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    test('agota los reintentos (MAX_RETRIES) y lanza si el error transitorio persiste', async () => {
        const adapter = new GeminiAdapter();
        mockGenerateContent
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }));

        await expect(adapter.generateSummary(makeActivities(), makeContext())).rejects.toThrow(/Gemini API error/);
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
});
