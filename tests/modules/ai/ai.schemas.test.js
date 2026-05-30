const {
    validateAIModuleOutput,
    validateUserContext,
} = require('../../../src/modules/ai/ai.schemas');

const validRow = {
    date: '2026-05-25',
    startTime: '09:00',
    endTime: '10:00',
    duration: 60,
    source: 'calendar',
    app: 'Meet',
    activityType: 'meeting',
    title: 'Daily standup',
    summary: 'Sync diario',
};

const validOutput = {
    daySummary: 'Día productivo',
    rows: [validRow],
    totalHours: 1,
};

describe('validateAIModuleOutput', () => {
    test('acepta un output válido y lo devuelve', () => {
        expect(validateAIModuleOutput(validOutput)).toEqual(validOutput);
    });

    test('description es opcional', () => {
        expect(() => validateAIModuleOutput(validOutput)).not.toThrow();
    });

    test('lanza si falta un campo requerido (summary) e incluye el path en el mensaje', () => {
        const invalid = { ...validOutput, rows: [{ ...validRow, summary: undefined }] };
        expect(() => validateAIModuleOutput(invalid)).toThrow(/AIModuleOutput validation failed/);
        expect(() => validateAIModuleOutput(invalid)).toThrow(/rows\.0\.summary/);
    });

    test('lanza si rows está vacío', () => {
        expect(() => validateAIModuleOutput({ ...validOutput, rows: [] })).toThrow(/al menos una fila/);
    });

    test('lanza si el formato de date es inválido', () => {
        const invalid = { ...validOutput, rows: [{ ...validRow, date: '25/05/2026' }] };
        expect(() => validateAIModuleOutput(invalid)).toThrow(/YYYY-MM-DD/);
    });

    test('lanza si source no está en el enum', () => {
        const invalid = { ...validOutput, rows: [{ ...validRow, source: 'slack' }] };
        expect(() => validateAIModuleOutput(invalid)).toThrow(/AIModuleOutput validation failed/);
    });

    test('lanza si totalHours no es positivo', () => {
        expect(() => validateAIModuleOutput({ ...validOutput, totalHours: 0 })).toThrow(/totalHours/);
    });
});

describe('validateUserContext', () => {
    test('acepta un contexto válido con date string', () => {
        const ctx = { name: 'Juan Pérez', role: 'employee', date: '2026-05-25' };
        expect(validateUserContext(ctx)).toEqual(ctx);
    });

    test('acepta date como objeto Date', () => {
        const ctx = { name: 'Juan', role: 'employee', date: new Date('2026-05-25') };
        expect(validateUserContext(ctx)).toEqual(ctx);
    });

    test('lanza si name está vacío', () => {
        expect(() => validateUserContext({ name: '', role: 'employee', date: '2026-05-25' })).toThrow(
            /UserContext validation failed/
        );
    });

    test('lanza si falta role', () => {
        expect(() => validateUserContext({ name: 'Juan', date: '2026-05-25' })).toThrow(
            /UserContext validation failed/
        );
    });
});
