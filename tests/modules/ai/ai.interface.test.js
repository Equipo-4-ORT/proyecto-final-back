const AIAdapter = require('../../../src/modules/ai/ai.interface');
const { AbstractMethodError } = AIAdapter;

describe('AIAdapter (abstract)', () => {

    test('no se puede instanciar directamente — fuerza usar una subclase', () => {
        expect(() => new AIAdapter()).toThrow(/abstracta/);
    });

    test('una subclase que no implementa generateSummary lanza AbstractMethodError', async () => {
        class IncompleteAdapter extends AIAdapter {}
        const adapter = new IncompleteAdapter();
        await expect(adapter.generateSummary([], {})).rejects.toThrow(AbstractMethodError);
    });

    test('AbstractMethodError tiene statusCode 501 (Not Implemented)', () => {
        const err = new AbstractMethodError('foo');
        expect(err.name).toBe('AbstractMethodError');
        expect(err.statusCode).toBe(501);
        expect(err.message).toContain('foo()');
    });

    test('una subclase que SÍ implementa generateSummary no lanza', async () => {
        class WorkingAdapter extends AIAdapter {
            async generateSummary() {
                return { daySummary: 'ok', rows: [], totalHours: 0 };
            }
        }
        const adapter = new WorkingAdapter();
        await expect(adapter.generateSummary([], {})).resolves.toEqual({
            daySummary: 'ok',
            rows: [],
            totalHours: 0,
        });
    });
});
