process.env.SCHEDULER_TIMEZONE = 'America/Argentina/Buenos_Aires';
process.env.SCHEDULER_CONCURRENCY = '5';

jest.mock('../../../src/shared/database/prisma', () => ({ user: { findMany: jest.fn() } }));
jest.mock('../../../src/shared/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../src/modules/scheduler/userSync.service', () => ({ syncUserActivities: jest.fn() }));
jest.mock('../../../src/modules/mail/mail.service', () => ({ sendActivityReadyEmail: jest.fn() }));

const { DateTime } = require('luxon');
const prisma = require('../../../src/shared/database/prisma');
const { syncUserActivities } = require('../../../src/modules/scheduler/userSync.service');
const mail = require('../../../src/modules/mail/mail.service');
const scheduler = require('../../../src/modules/scheduler/scheduler.service');

const TZ = 'America/Argentina/Buenos_Aires';

const userRow = (over = {}) => ({
    id: 'u1',
    email: 'u1@test.com',
    workStartTime: '09:00',
    workEndTime: '18:00',
    refreshToken: 'x',
    googleReconnectRequired: false,
    jiraRefreshToken: null,
    jiraCloudId: null,
    jiraReconnectRequired: false,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    scheduler._resetState();
    syncUserActivities.mockResolvedValue({ totalImported: 5, sources: {}, errors: [] });
    mail.sendActivityReadyEmail.mockResolvedValue({ sent: true });
});

describe('runTick', () => {
    test('CA-01 / CA-10: busca EMPLOYEE+ACTIVE con workEndTime en formato 24h', async () => {
        prisma.user.findMany.mockResolvedValue([]);
        const now = DateTime.fromISO('2026-06-10T21:00:00', { zone: TZ }); // 21:00, no 09:00
        await scheduler.runTick(now);
        expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ role: 'EMPLOYEE', status: 'ACTIVE', workEndTime: '21:00' }),
            }),
        );
    });

    test('procesa a los matcheados: sincroniza y avisa por email si hubo actividad', async () => {
        prisma.user.findMany.mockResolvedValue([userRow()]);
        await scheduler.runTick(DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ }));
        expect(syncUserActivities).toHaveBeenCalledTimes(1);
        expect(mail.sendActivityReadyEmail).toHaveBeenCalledWith('u1@test.com', expect.objectContaining({ date: '2026-06-10' }));
    });

    test('CA-04: sin actividad nueva → no envía email', async () => {
        syncUserActivities.mockResolvedValue({ totalImported: 0, sources: {}, errors: [] });
        prisma.user.findMany.mockResolvedValue([userRow()]);
        await scheduler.runTick(DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ }));
        expect(mail.sendActivityReadyEmail).not.toHaveBeenCalled();
    });

    test('CA-05: falla el email → no rompe el procesamiento', async () => {
        mail.sendActivityReadyEmail.mockRejectedValue(new Error('smtp down'));
        prisma.user.findMany.mockResolvedValue([userRow()]);
        await expect(scheduler.runTick(DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ }))).resolves.toBeDefined();
        expect(syncUserActivities).toHaveBeenCalledTimes(1);
    });

    test('CA-06: el fallo de un usuario no frena a los demás del lote', async () => {
        syncUserActivities
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue({ totalImported: 1, sources: {}, errors: [] });
        prisma.user.findMany.mockResolvedValue([
            userRow({ id: 'u1', email: 'a@test.com' }),
            userRow({ id: 'u2', email: 'b@test.com' }),
        ]);
        const r = await scheduler.runTick(DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ }));
        expect(syncUserActivities).toHaveBeenCalledTimes(2);
        expect(r.matched).toBe(2);
    });

    test('E-09: ticks solapados del mismo minuto no procesan dos veces al usuario', async () => {
        prisma.user.findMany.mockResolvedValue([userRow()]);
        let resolveSync;
        syncUserActivities.mockReturnValue(
            new Promise((res) => {
                resolveSync = () => res({ totalImported: 0, sources: {}, errors: [] });
            }),
        );
        const now = DateTime.fromISO('2026-06-10T18:00:00', { zone: TZ });
        const p1 = scheduler.runTick(now);
        const p2 = scheduler.runTick(now); // solapado, mientras el 1º sigue en vuelo
        resolveSync();
        await Promise.all([p1, p2]);
        expect(syncUserActivities).toHaveBeenCalledTimes(1);
    });
});
