process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));
jest.mock('../../../src/shared/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mailService = require('../../../src/modules/mail/mail.service');

describe('mail.service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mailService._resetTransporter();
        process.env.SMTP_HOST = 'smtp.test.com';
        process.env.SMTP_FROM = 'no-reply@test.com';
        process.env.SMTP_PORT = '587';
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
    });

    test('V-02: degrada si SMTP no está configurado (no envía)', async () => {
        delete process.env.SMTP_HOST;
        const r = await mailService.sendActivityReadyEmail('user@test.com', { date: '2026-06-10' });
        expect(r.sent).toBe(false);
        expect(r.reason).toBe('smtp_not_configured');
        expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('envía con link al /dashboard cuando hay SMTP', async () => {
        mockSendMail.mockResolvedValue({ messageId: 'abc' });
        const r = await mailService.sendActivityReadyEmail('user@test.com', { date: '2026-06-10' });
        expect(r.sent).toBe(true);
        expect(mockSendMail).toHaveBeenCalledTimes(1);
        const arg = mockSendMail.mock.calls[0][0];
        expect(arg.to).toBe('user@test.com');
        expect(arg.from).toBe('no-reply@test.com');
        expect(arg.text).toContain('http://localhost:5173/dashboard');
        expect(arg.html).toContain('http://localhost:5173/dashboard');
    });

    test('propaga el error si el envío falla (lo registra el dispatcher)', async () => {
        mockSendMail.mockRejectedValue(new Error('smtp down'));
        await expect(mailService.sendActivityReadyEmail('u@test.com', {})).rejects.toThrow('smtp down');
    });
});
