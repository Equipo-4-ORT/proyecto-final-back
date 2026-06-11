const { mapWithConcurrency } = require('../../../src/shared/utils/concurrency');

describe('mapWithConcurrency', () => {
    test('procesa todos los items y preserva el orden de entrada', async () => {
        const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 10);
        expect(result).toEqual([10, 20, 30, 40, 50]);
    });

    test('no excede el límite de concurrencia', async () => {
        let active = 0;
        let maxActive = 0;
        const items = Array.from({ length: 12 }, (_, i) => i);
        await mapWithConcurrency(items, 3, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
        });
        expect(maxActive).toBeLessThanOrEqual(3);
        expect(maxActive).toBeGreaterThan(1);
    });

    test('array vacío devuelve []', async () => {
        expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
    });
});
