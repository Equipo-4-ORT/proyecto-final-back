const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

// Test de integración contra la API REAL de OpenAI. Solo corre si hay una
// API key seteada (entorno local). En CI la key no está → el bloque se reporta
// como "skipped", NO como un test verde sin asserts (evita falsos positivos).
const describeIfApiKey = process.env.OPENAI_API_KEY ? describe : describe.skip;

describeIfApiKey('OpenAIAdapter - Integration Test (Real OpenAI API)', () => {
    let adapter;

    beforeAll(() => {
        adapter = new OpenAIAdapter();
    });

    test('generateSummary funciona contra la API real de OpenAI', async () => {
        const activities = [
            {
                id: 'act1',
                source: 'calendar',
                activityType: 'meeting',
                startTime: new Date('2026-05-25T09:00:00Z'),
                endTime: new Date('2026-05-25T10:00:00Z'),
                metadata: { title: 'Daily standup' },
            },
            {
                id: 'act2',
                source: 'jira',
                activityType: 'task',
                startTime: new Date('2026-05-25T10:00:00Z'),
                endTime: new Date('2026-05-25T12:00:00Z'),
                metadata: { title: 'Implement feature X' },
            },
        ];
        const userContext = { name: 'Santiago Nuñez', role: 'developer', date: '2026-05-25' };

        const result = await adapter.generateSummary(activities, userContext);

        expect(result).toHaveProperty('daySummary');
        expect(result).toHaveProperty('rows');
        expect(result).toHaveProperty('totalHours');
        expect(Array.isArray(result.rows)).toBe(true);
    }, 30000);
});
