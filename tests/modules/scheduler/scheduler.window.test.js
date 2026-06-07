const { DateTime } = require('luxon');
const {
    buildWorkdayWindow,
    InvalidWorkdayWindowError,
} = require('../../../src/modules/scheduler/scheduler.window');

// Buenos Aires: UTC-3 fijo (sin DST desde 2009), ideal para asserts deterministas.
const TZ = 'America/Argentina/Buenos_Aires';

describe('buildWorkdayWindow', () => {
    test('jornada normal: arma [start, end) del mismo día en UTC', () => {
        const ref = DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ });
        const { start, end } = buildWorkdayWindow('09:00', '18:00', ref, TZ);
        // 09:00 ART = 12:00Z ; 18:00 ART = 21:00Z
        expect(start.toISOString()).toBe('2026-06-10T12:00:00.000Z');
        expect(end.toISOString()).toBe('2026-06-10T21:00:00.000Z');
    });

    test('CA-08 turno nocturno (end <= start): el inicio cae el día anterior', () => {
        const ref = DateTime.fromISO('2026-06-10T02:00:00', { zone: TZ });
        const { start, end } = buildWorkdayWindow('21:00', '02:00', ref, TZ);
        // start: 2026-06-09 21:00 ART = 2026-06-10T00:00Z ; end: 2026-06-10 02:00 ART = 2026-06-10T05:00Z
        expect(start.toISOString()).toBe('2026-06-10T00:00:00.000Z');
        expect(end.toISOString()).toBe('2026-06-10T05:00:00.000Z');
        expect(end.getTime() - start.getTime()).toBe(5 * 60 * 60 * 1000);
    });

    test('borde start == end: jornada de 24h', () => {
        const ref = DateTime.fromISO('2026-06-10T09:00:00', { zone: TZ });
        const { start, end } = buildWorkdayWindow('09:00', '09:00', ref, TZ);
        expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    test('lanza con horas inválidas', () => {
        const ref = DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ });
        expect(() => buildWorkdayWindow('25:00', '18:00', ref, TZ)).toThrow(InvalidWorkdayWindowError);
        expect(() => buildWorkdayWindow('09:00', 'xx:yy', ref, TZ)).toThrow(InvalidWorkdayWindowError);
    });

    test('lanza con timezone inválida', () => {
        const ref = DateTime.now();
        expect(() => buildWorkdayWindow('09:00', '18:00', ref, 'Not/AZone')).toThrow(InvalidWorkdayWindowError);
    });
});
