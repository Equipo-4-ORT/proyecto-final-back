jest.mock('../../../src/shared/database/prisma', () => ({ user: { update: jest.fn() } }));
jest.mock('../../../src/shared/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../src/shared/utils/crypto', () => ({ decrypt: jest.fn(() => 'plain-token') }));
jest.mock('../../../src/modules/calendar/calendar.service', () => ({ persistCalendarActivitiesInWindow: jest.fn() }));
jest.mock('../../../src/modules/drive/drive-activity.service', () => ({ persistDriveActivities: jest.fn() }));
jest.mock('../../../src/modules/jira/jira.service', () => ({ syncForUser: jest.fn() }));

const prisma = require('../../../src/shared/database/prisma');
const calendar = require('../../../src/modules/calendar/calendar.service');
const drive = require('../../../src/modules/drive/drive-activity.service');
const jira = require('../../../src/modules/jira/jira.service');
const {
    syncUserActivities,
    looksLikeGoogleAuthError,
} = require('../../../src/modules/scheduler/userSync.service');

const window = { start: new Date('2026-06-10T12:00:00Z'), end: new Date('2026-06-10T21:00:00Z') };

const baseUser = (over = {}) => ({
    id: 'u1',
    email: 'u1@test.com',
    refreshToken: 'enc-google',
    googleReconnectRequired: false,
    jiraRefreshToken: 'enc-jira',
    jiraCloudId: 'cloud-1',
    jiraReconnectRequired: false,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    calendar.persistCalendarActivitiesInWindow.mockResolvedValue({ count: 1 });
    drive.persistDriveActivities.mockResolvedValue({ count: 2 });
    jira.syncForUser.mockResolvedValue({ imported: 3 });
});

describe('syncUserActivities', () => {
    test('CA-02: Google conectado, Jira no → sincroniza Calendar+Drive, omite Jira', async () => {
        const user = baseUser({ jiraRefreshToken: null, jiraCloudId: null });
        const r = await syncUserActivities(user, window);
        expect(calendar.persistCalendarActivitiesInWindow).toHaveBeenCalledWith('u1', 'plain-token', window.start, window.end);
        expect(drive.persistDriveActivities).toHaveBeenCalled();
        expect(jira.syncForUser).not.toHaveBeenCalled();
        expect(r.totalImported).toBe(3); // 1 (cal) + 2 (drive) + 0 (jira omitido)
    });

    test('CA-07: googleReconnectRequired → no llama a las APIs de Google', async () => {
        const user = baseUser({ googleReconnectRequired: true });
        await syncUserActivities(user, window);
        expect(calendar.persistCalendarActivitiesInWindow).not.toHaveBeenCalled();
        expect(drive.persistDriveActivities).not.toHaveBeenCalled();
        expect(jira.syncForUser).toHaveBeenCalled();
    });

    test('Google sin token → omite Google, sincroniza Jira', async () => {
        const user = baseUser({ refreshToken: null });
        await syncUserActivities(user, window);
        expect(calendar.persistCalendarActivitiesInWindow).not.toHaveBeenCalled();
        expect(jira.syncForUser).toHaveBeenCalled();
    });

    test('RN-B05: el error de una fuente no frena a las otras', async () => {
        drive.persistDriveActivities.mockRejectedValue(new Error('drive 500'));
        const r = await syncUserActivities(baseUser(), window);
        expect(r.sources.calendar).toBe(1);
        expect(r.sources.drive).toBeNull();
        expect(r.sources.jira).toBe(3);
        expect(r.errors).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'drive' })]));
    });

    test('RN-B12: error de auth de Google marca googleReconnectRequired', async () => {
        calendar.persistCalendarActivitiesInWindow.mockRejectedValue(new Error('invalid_grant'));
        await syncUserActivities(baseUser(), window);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { googleReconnectRequired: true },
        });
    });

    test('jiraReconnectRequired → omite Jira', async () => {
        const user = baseUser({ jiraReconnectRequired: true });
        await syncUserActivities(user, window);
        expect(jira.syncForUser).not.toHaveBeenCalled();
    });
});

describe('looksLikeGoogleAuthError', () => {
    test('detecta invalid_grant y status 401 (incluso anidado en cause)', () => {
        expect(looksLikeGoogleAuthError(new Error('invalid_grant'))).toBe(true);
        expect(looksLikeGoogleAuthError(Object.assign(new Error('wrap'), { cause: { response: { status: 401 } } }))).toBe(true);
        expect(looksLikeGoogleAuthError(new Error('network timeout'))).toBe(false);
        expect(looksLikeGoogleAuthError(null)).toBe(false);
    });
});
