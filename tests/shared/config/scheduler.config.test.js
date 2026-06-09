const config = require('../../../src/shared/config');

describe('scheduler config', () => {
    const OLD = { ...process.env };
    afterEach(() => {
        process.env = { ...OLD };
    });

    test('validateSchedulerConfig: TZ válida → valid', () => {
        process.env.SCHEDULER_TIMEZONE = 'America/Argentina/Buenos_Aires';
        const r = config.validateSchedulerConfig();
        expect(r.valid).toBe(true);
        expect(r.timezone).toBe('America/Argentina/Buenos_Aires');
    });

    test('CA-09 validateSchedulerConfig: TZ inválida → invalid', () => {
        process.env.SCHEDULER_TIMEZONE = 'Not/AZone';
        const r = config.validateSchedulerConfig();
        expect(r.valid).toBe(false);
        expect(r.error).toMatch(/SCHEDULER_TIMEZONE/);
    });

    test('validateSchedulerConfig: TZ ausente → invalid', () => {
        delete process.env.SCHEDULER_TIMEZONE;
        expect(config.validateSchedulerConfig().valid).toBe(false);
    });

    test('schedulerConcurrency: default 5 y parseo defensivo', () => {
        delete process.env.SCHEDULER_CONCURRENCY;
        expect(config.schedulerConcurrency).toBe(5);
        process.env.SCHEDULER_CONCURRENCY = '8';
        expect(config.schedulerConcurrency).toBe(8);
        process.env.SCHEDULER_CONCURRENCY = '0';
        expect(config.schedulerConcurrency).toBe(5);
    });

    test('schedulerEnabled: default true; "false" lo desactiva', () => {
        delete process.env.SCHEDULER_ENABLED;
        expect(config.schedulerEnabled).toBe(true);
        process.env.SCHEDULER_ENABLED = 'false';
        expect(config.schedulerEnabled).toBe(false);
    });

    test('smtpConfigured: requiere host y from', () => {
        delete process.env.SMTP_HOST;
        delete process.env.SMTP_FROM;
        expect(config.smtpConfigured).toBe(false);
        process.env.SMTP_HOST = 'smtp.test';
        process.env.SMTP_FROM = 'no-reply@test';
        expect(config.smtpConfigured).toBe(true);
    });
});
