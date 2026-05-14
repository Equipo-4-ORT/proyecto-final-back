process.env.JIRA_CLIENT_ID = 'test-client-id';
process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
process.env.JIRA_REDIRECT_URI = 'http://localhost:3000/api/jira/auth/callback';
process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

jest.mock('../../../src/shared/database/prisma', () => ({
    user: { findUnique: jest.fn(), update: jest.fn() },
    jiraOAuthState: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    dailyActivity: { createMany: jest.fn() },
}));
jest.mock('../../../src/modules/jira/jira.client');
jest.mock('../../../src/shared/utils/crypto', () => ({
    encrypt: jest.fn((text) => `enc(${text})`),
    decrypt: jest.fn((cipher) => String(cipher).replace(/^enc\(/, '').replace(/\)$/, '')),
}));
jest.mock('../../../src/shared/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const prisma = require('../../../src/shared/database/prisma');
const client = require('../../../src/modules/jira/jira.client');
const { decrypt } = require('../../../src/shared/utils/crypto');
const service = require('../../../src/modules/jira/jira.service');
const {
    JiraUserNotFoundError,
    JiraNotConnectedError,
    JiraReconnectRequiredError,
    JiraInvalidWindowError,
    JiraTokenExchangeError,
    JiraUpstreamError,
} = require('../../../src/modules/jira/jira.errors');

const HEX64 = /^[0-9a-f]{64}$/;
const WINDOW_START = '2026-05-10T09:00:00.000Z';
const WINDOW_END = '2026-05-10T18:00:00.000Z';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('jira.service — initiateConnection', () => {
    test('happy path: valida user, persiste state con TTL y devuelve la URL de autorización', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        prisma.jiraOAuthState.create.mockResolvedValue({});
        client.buildAuthorizationUrl.mockReturnValue('https://auth.atlassian.com/authorize?state=xxx');

        const before = Date.now();
        const result = await service.initiateConnection('u1');

        expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
        expect(prisma.jiraOAuthState.create).toHaveBeenCalledTimes(1);
        const createArg = prisma.jiraOAuthState.create.mock.calls[0][0];
        expect(createArg.data.userId).toBe('u1');
        expect(createArg.data.state).toMatch(HEX64);
        expect(createArg.data.expiresAt.getTime()).toBeGreaterThan(before + 9 * 60 * 1000);
        expect(client.buildAuthorizationUrl).toHaveBeenCalledWith(createArg.data.state);
        expect(result).toEqual({ authorizationUrl: 'https://auth.atlassian.com/authorize?state=xxx' });
    });

    test('user inexistente → JiraUserNotFoundError, no persiste state', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        await expect(service.initiateConnection('ghost')).rejects.toThrow(JiraUserNotFoundError);
        expect(prisma.jiraOAuthState.create).not.toHaveBeenCalled();
    });
});

describe('jira.service — handleCallback', () => {
    test('happy path: intercambia code, descubre cloudId, persiste cifrado y consume el state', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() + 60000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        client.exchangeCodeForTokens.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
        client.getAccessibleResources.mockResolvedValue([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]);
        prisma.user.update.mockResolvedValue({});

        const result = await service.handleCallback({ code: 'C', state: 'S' });

        expect(result).toEqual({ outcome: 'connected' });
        expect(prisma.jiraOAuthState.delete).toHaveBeenCalledWith({ where: { state: 'S' } });
        expect(client.exchangeCodeForTokens).toHaveBeenCalledWith('C');
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: expect.objectContaining({
                jiraRefreshToken: 'enc(RT)',
                jiraCloudId: 'cloud-1',
                jiraSiteUrl: 'https://acme.atlassian.net',
                jiraReconnectRequired: false,
                jiraConnectedAt: expect.any(Date),
            }),
        });
    });

    test('error=access_denied → outcome cancelled, sin tocar la BD', async () => {
        const result = await service.handleCallback({ error: 'access_denied' });
        expect(result).toEqual({ outcome: 'cancelled' });
        expect(prisma.jiraOAuthState.findUnique).not.toHaveBeenCalled();
    });

    test('error genérico de Atlassian → token_exchange_failed', async () => {
        const result = await service.handleCallback({ error: 'server_error' });
        expect(result).toEqual({ outcome: 'error', reason: 'token_exchange_failed' });
    });

    test('faltan code o state → invalid_state', async () => {
        await expect(service.handleCallback({})).resolves.toEqual({ outcome: 'error', reason: 'invalid_state' });
        await expect(service.handleCallback({ code: 'C' })).resolves.toEqual({ outcome: 'error', reason: 'invalid_state' });
    });

    test('state desconocido → invalid_state', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue(null);
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'invalid_state' });
        expect(client.exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    test('state expirado → invalid_state y se borra el registro', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() - 1000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'invalid_state' });
        expect(prisma.jiraOAuthState.delete).toHaveBeenCalledWith({ where: { state: 'S' } });
        expect(client.exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    test('state válido pero user borrado → user_not_found', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() + 60000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        prisma.user.findUnique.mockResolvedValue(null);
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'user_not_found' });
    });

    test('exchange de code falla → token_exchange_failed', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() + 60000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        client.exchangeCodeForTokens.mockRejectedValue(new JiraTokenExchangeError());
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'token_exchange_failed' });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('accessible-resources vacío → no_jira_site', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() + 60000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        client.exchangeCodeForTokens.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
        client.getAccessibleResources.mockResolvedValue([]);
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'no_jira_site' });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('falla la persistencia del callback → persistence_failed', async () => {
        prisma.jiraOAuthState.findUnique.mockResolvedValue({ state: 'S', userId: 'u1', expiresAt: new Date(Date.now() + 60000) });
        prisma.jiraOAuthState.delete.mockResolvedValue({});
        prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
        client.exchangeCodeForTokens.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT' });
        client.getAccessibleResources.mockResolvedValue([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]);
        prisma.user.update.mockRejectedValue(new Error('db down'));
        const result = await service.handleCallback({ code: 'C', state: 'S' });
        expect(result).toEqual({ outcome: 'error', reason: 'persistence_failed' });
    });
});

describe('jira.service — getStatus', () => {
    test('user conectado', async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 'u1',
            jiraRefreshToken: 'enc(RT)',
            jiraCloudId: 'cloud-1',
            jiraSiteUrl: 'acme.atlassian.net',
            jiraLastSyncAt: new Date('2026-05-09T22:00:00.000Z'),
            jiraReconnectRequired: false,
        });
        const result = await service.getStatus('u1');
        expect(result).toEqual({
            connected: true,
            siteUrl: 'acme.atlassian.net',
            lastSyncAt: new Date('2026-05-09T22:00:00.000Z'),
            reconnectRequired: false,
        });
    });

    test('user desconectado → connected false y el resto null', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: null, jiraCloudId: null });
        const result = await service.getStatus('u1');
        expect(result).toEqual({ connected: false, siteUrl: null, lastSyncAt: null, reconnectRequired: false });
    });

    test('user con reconnectRequired', async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 'u1', jiraRefreshToken: 'enc(RT)', jiraCloudId: 'cloud-1', jiraSiteUrl: 'acme.atlassian.net', jiraReconnectRequired: true,
        });
        const result = await service.getStatus('u1');
        expect(result.reconnectRequired).toBe(true);
        expect(result.connected).toBe(true);
    });

    test('user inexistente → JiraUserNotFoundError', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        await expect(service.getStatus('ghost')).rejects.toThrow(JiraUserNotFoundError);
    });
});

describe('jira.service — disconnect', () => {
    test('happy path conectado: revoca, borra credenciales, conserva activities', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: 'enc(RT)' });
        client.revokeRefreshToken.mockResolvedValue(true);
        prisma.user.update.mockResolvedValue({});

        await service.disconnect('u1');

        expect(decrypt).toHaveBeenCalledWith('enc(RT)');
        expect(client.revokeRefreshToken).toHaveBeenCalledWith('RT');
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: {
                jiraRefreshToken: null,
                jiraCloudId: null,
                jiraSiteUrl: null,
                jiraConnectedAt: null,
                jiraReconnectRequired: false,
            },
        });
        expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
    });

    test('revoke falla (best effort): igualmente limpia credenciales', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: 'enc(RT)' });
        client.revokeRefreshToken.mockResolvedValue(false);
        prisma.user.update.mockResolvedValue({});
        await service.disconnect('u1');
        expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    test('decrypt falla: no revoca pero igual limpia credenciales', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: 'corrupto' });
        decrypt.mockImplementationOnce(() => { throw new Error('bad ciphertext'); });
        prisma.user.update.mockResolvedValue({});
        await service.disconnect('u1');
        expect(client.revokeRefreshToken).not.toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    test('user no conectado → no revoca, igual hace el update (idempotente)', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: null });
        prisma.user.update.mockResolvedValue({});
        await service.disconnect('u1');
        expect(client.revokeRefreshToken).not.toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    test('user inexistente → no-op idempotente, no lanza (para admin delete)', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        await expect(service.disconnect('ghost', { source: 'admin_delete' })).resolves.toBeUndefined();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(client.revokeRefreshToken).not.toHaveBeenCalled();
    });
});

describe('jira.service — syncForUser', () => {
    const connectedUser = {
        id: 'u1',
        jiraRefreshToken: 'enc(RT)',
        jiraCloudId: 'cloud-1',
        jiraReconnectRequired: false,
    };

    const inWindowComment = (id) => ({ id, author: { accountId: 'acc-me' }, created: '2026-05-10T10:00:00.000Z' });

    test('happy path: refresca token, persiste el nuevo refresh, importa actividades y marca lastSyncAt', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2', expiresIn: 3600 });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me', emailAddress: 'me@acme.com' });
        client.searchIssuesUpdatedInRange.mockResolvedValue([{ key: 'P-1', fields: { summary: 'S', status: { name: 'In Progress' }, project: { key: 'P' } } }]);
        client.getChangelog.mockResolvedValue([]);
        client.getComments.mockResolvedValue([inWindowComment('c1')]);
        client.getWorklogs.mockResolvedValue([]);
        prisma.dailyActivity.createMany.mockResolvedValue({ count: 1 });

        const result = await service.syncForUser('u1', WINDOW_START, WINDOW_END);

        expect(client.refreshAccessToken).toHaveBeenCalledWith('RT');
        // El nuevo refresh se persiste ANTES de usar el access:
        expect(prisma.user.update).toHaveBeenNthCalledWith(1, { where: { id: 'u1' }, data: { jiraRefreshToken: 'enc(RT2)' } });
        expect(client.searchIssuesUpdatedInRange).toHaveBeenCalledWith('cloud-1', 'AT', expect.any(Date), expect.any(Date));
        expect(prisma.dailyActivity.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([expect.objectContaining({ source: 'jira', activityType: 'comment', userId: 'u1' })]),
            skipDuplicates: true,
        });
        expect(prisma.user.update).toHaveBeenNthCalledWith(2, { where: { id: 'u1' }, data: { jiraLastSyncAt: expect.any(Date) } });
        expect(result).toEqual({ imported: 1, skippedDuplicates: 0, durationMs: expect.any(Number) });
    });

    test('dateStart >= dateEnd → JiraInvalidWindowError', async () => {
        await expect(service.syncForUser('u1', WINDOW_END, WINDOW_START)).rejects.toThrow(JiraInvalidWindowError);
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('fechas no ISO → JiraInvalidWindowError', async () => {
        await expect(service.syncForUser('u1', 'garbage', 'also-garbage')).rejects.toThrow(JiraInvalidWindowError);
    });

    test('ventana > 24h → JiraInvalidWindowError', async () => {
        await expect(service.syncForUser('u1', '2026-05-10T00:00:00.000Z', '2026-05-12T00:00:00.000Z')).rejects.toThrow(JiraInvalidWindowError);
    });

    test('user inexistente → JiraUserNotFoundError', async () => {
        prisma.user.findUnique.mockResolvedValue(null);
        await expect(service.syncForUser('ghost', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraUserNotFoundError);
    });

    test('user no conectado → JiraNotConnectedError', async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 'u1', jiraRefreshToken: null, jiraCloudId: null });
        await expect(service.syncForUser('u1', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraNotConnectedError);
        expect(client.refreshAccessToken).not.toHaveBeenCalled();
    });

    test('reconnectRequired ya activo → JiraReconnectRequiredError sin llamar refresh', async () => {
        prisma.user.findUnique.mockResolvedValue({ ...connectedUser, jiraReconnectRequired: true });
        await expect(service.syncForUser('u1', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraReconnectRequiredError);
        expect(client.refreshAccessToken).not.toHaveBeenCalled();
    });

    test('refresh devuelve invalid_grant → marca reconnectRequired y re-lanza', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockRejectedValue(new JiraReconnectRequiredError());
        prisma.user.update.mockResolvedValue({});
        await expect(service.syncForUser('u1', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraReconnectRequiredError);
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { jiraReconnectRequired: true } });
        expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
    });

    test('error upstream mid-sync (401 en /search) → marca reconnectRequired y re-lanza', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2' });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me' });
        client.searchIssuesUpdatedInRange.mockRejectedValue(new JiraReconnectRequiredError());
        await expect(service.syncForUser('u1', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraReconnectRequiredError);
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { jiraReconnectRequired: true } });
    });

    test('error upstream no recuperable (502) se propaga', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2' });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me' });
        client.searchIssuesUpdatedInRange.mockRejectedValue(new JiraUpstreamError());
        await expect(service.syncForUser('u1', WINDOW_START, WINDOW_END)).rejects.toThrow(JiraUpstreamError);
    });

    test('ventana sin actividad → imported 0, marca lastSyncAt, no inserta', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2' });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me' });
        client.searchIssuesUpdatedInRange.mockResolvedValue([]);
        const result = await service.syncForUser('u1', WINDOW_START, WINDOW_END);
        expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenNthCalledWith(2, { where: { id: 'u1' }, data: { jiraLastSyncAt: expect.any(Date) } });
        expect(result).toEqual({ imported: 0, skippedDuplicates: 0, durationMs: expect.any(Number) });
    });

    test('idempotente: segundo run no inserta duplicados (createMany count 0)', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2' });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me' });
        client.searchIssuesUpdatedInRange.mockResolvedValue([{ key: 'P-1', fields: {} }]);
        client.getChangelog.mockResolvedValue([]);
        client.getComments.mockResolvedValue([inWindowComment('c1'), inWindowComment('c2')]);
        client.getWorklogs.mockResolvedValue([]);
        prisma.dailyActivity.createMany.mockResolvedValue({ count: 0 });

        const result = await service.syncForUser('u1', WINDOW_START, WINDOW_END);
        expect(prisma.dailyActivity.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
        expect(result.imported).toBe(0);
        expect(result.skippedDuplicates).toBe(2);
    });

    test('acciones fuera de la ventana no se importan', async () => {
        prisma.user.findUnique.mockResolvedValue(connectedUser);
        client.refreshAccessToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT2' });
        prisma.user.update.mockResolvedValue({});
        client.getMyself.mockResolvedValue({ accountId: 'acc-me' });
        client.searchIssuesUpdatedInRange.mockResolvedValue([{ key: 'P-1', fields: {} }]);
        client.getChangelog.mockResolvedValue([]);
        client.getComments.mockResolvedValue([{ id: 'c1', author: { accountId: 'acc-me' }, created: '2026-05-10T08:30:00.000Z' }]); // antes de la ventana
        client.getWorklogs.mockResolvedValue([]);
        const result = await service.syncForUser('u1', WINDOW_START, WINDOW_END);
        expect(prisma.dailyActivity.createMany).not.toHaveBeenCalled();
        expect(result.imported).toBe(0);
    });
});
