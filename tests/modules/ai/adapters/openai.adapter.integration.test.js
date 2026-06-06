const OpenAIAdapter = require('../../../../src/modules/ai/adapters/openai.adapter');

describe('OpenAIAdapter - Integration Test with Real OpenAI API', () => {
    let adapter;

    beforeAll(() => {
        if (!process.env.OPENAI_API_KEY) {
            console.warn('⚠️  OPENAI_API_KEY not set. Skipping integration tests.');
        }
        adapter = new OpenAIAdapter();
    });

    test('generateSummary debe funcionar con OpenAI API real', async () => {
        if (!process.env.OPENAI_API_KEY) {
            console.warn('⏭️  Skipping: No API key');
            return;
        }

        const mockActivities = [
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

        const userContext = {
            name: 'Santiago Nuñez',
            role: 'developer',
            date: '2026-05-25',
        };

        try {
            const result = await adapter.generateSummary(mockActivities, userContext);

            expect(result).toHaveProperty('daySummary');
            expect(result).toHaveProperty('rows');
            expect(result).toHaveProperty('totalHours');
            expect(Array.isArray(result.rows)).toBe(true);
        } catch (error) {
            // Atrapamos el error de facturación para evitar que rompa el CI/CD
            if (error.message.includes('429') || error.message.includes('rate limit')) {
                console.warn('⚠️ OpenAI rate limit exceeded. Test ignorado de forma segura.');
                return; 
            }
            // Si el error es de lógica o código roto, sí debe fallar
            throw error;
        }
    }, 30000);
});