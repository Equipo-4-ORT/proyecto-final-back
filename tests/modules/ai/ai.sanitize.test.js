const {
    sanitizeForExcel,
    sanitizeForPrompt,
    sanitizeObjectForExcel,
} = require('../../../src/modules/ai/ai.sanitize');

describe('sanitizeForExcel', () => {
    test.each(['=SUM(A1)', '+1', '-1', '@cmd'])('prefija apóstrofo a strings que empiezan con %s', (input) => {
        expect(sanitizeForExcel(input)).toBe(`'${input}`);
    });

    test('no toca strings seguros', () => {
        expect(sanitizeForExcel('hola mundo')).toBe('hola mundo');
        expect(sanitizeForExcel('Pérez')).toBe('Pérez');
    });

    test('devuelve valores falsy / no-string sin cambios', () => {
        expect(sanitizeForExcel('')).toBe('');
        expect(sanitizeForExcel(null)).toBeNull();
        expect(sanitizeForExcel(undefined)).toBeUndefined();
    });
});

describe('sanitizeForPrompt', () => {
    test('preserva acentos y ñ (contenido en español)', () => {
        expect(sanitizeForPrompt('Pérez Núñez áéíóú ÁÉÍ')).toBe('Pérez Núñez áéíóú ÁÉÍ');
    });

    test('remueve caracteres de control C0/DEL', () => {
        const ctrl = String.fromCharCode(0, 7, 31, 127);
        expect(sanitizeForPrompt(`a${ctrl}b`)).toBe('ab');
    });

    test('preserva tab, newline y carriage return', () => {
        expect(sanitizeForPrompt('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    });

    test('hace trim de los extremos', () => {
        expect(sanitizeForPrompt('  hola  ')).toBe('hola');
    });

    test('devuelve valores falsy / no-string sin cambios', () => {
        expect(sanitizeForPrompt('')).toBe('');
        expect(sanitizeForPrompt(null)).toBeNull();
    });
});

describe('sanitizeObjectForExcel', () => {
    test('escapa strings peligrosos en objetos anidados', () => {
        const input = { title: '=HYPERLINK("x")', nested: { summary: '+1' } };
        expect(sanitizeObjectForExcel(input)).toEqual({
            title: '\'=HYPERLINK("x")',
            nested: { summary: "'+1" },
        });
    });

    test('procesa arrays recursivamente', () => {
        const input = { rows: [{ title: '=A1' }, { title: 'ok' }] };
        const out = sanitizeObjectForExcel(input);
        expect(out.rows[0].title).toBe("'=A1");
        expect(out.rows[1].title).toBe('ok');
    });

    test('preserva tipos no-string (números, booleanos, null)', () => {
        const input = { duration: 60, active: true, note: null };
        expect(sanitizeObjectForExcel(input)).toEqual({ duration: 60, active: true, note: null });
    });

    test('devuelve no-objetos sin cambios', () => {
        expect(sanitizeObjectForExcel('hola')).toBe('hola');
        expect(sanitizeObjectForExcel(42)).toBe(42);
        expect(sanitizeObjectForExcel(null)).toBeNull();
    });
});
