process.env.JIRA_CLIENT_ID = 'test-client-id';
process.env.JIRA_CLIENT_SECRET = 'test-client-secret';
process.env.JIRA_REDIRECT_URI = 'http://localhost:3000/api/jira/auth/callback';
process.env.FRONTEND_BASE_URL = 'http://localhost:5173';

const client = require('../../../src/modules/jira/jira.client');
const { config } = require('../../../src/modules/jira/jira.constants');
const {
    JiraTokenExchangeError,
    JiraUpstreamError,
    JiraReconnectRequiredError,
    JiraTimeoutError,
} = require('../../../src/modules/jira/jira.errors');

const okJson = (body, { status = 200 } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
});

const errResponse = (status, { body = null, retryAfter = null } = {}) => ({
    ok: false,
    status,
    headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) },
    json: async () => body,
});

describe('jira.client', () => {
    const originalTimeout = config.requestTimeoutMs;

    beforeEach(() => {
        global.fetch = jest.fn();
        // Acelerar los backoffs de retry para los tests.
        client._internal.RETRY.timeoutDelayMs = 0;
        client._internal.RETRY.rateLimitDelayMs = 0;
        client._internal.RETRY.serverErrorDelaysMs = [0, 0];
        config.requestTimeoutMs = originalTimeout;
    });

    afterEach(() => {
        jest.clearAllMocks();
        config.requestTimeoutMs = originalTimeout;
    });

    describe('buildAuthorizationUrl', () => {
        test('arma la URL con scopes, redirect_uri, state y prompt=consent', () => {
            const url = new URL(client.buildAuthorizationUrl('state-abc'));
            expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
            expect(url.searchParams.get('client_id')).toBe('test-client-id');
            expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
            expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/jira/auth/callback');
            expect(url.searchParams.get('state')).toBe('state-abc');
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('prompt')).toBe('consent');
            expect(url.searchParams.get('scope')).toContain('offline_access');
        });
    });

    describe('exchangeCodeForTokens', () => {
        test('happy path devuelve access + refresh', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
            const result = await client.exchangeCodeForTokens('the-code');
            expect(result).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
            const [url, opts] = global.fetch.mock.calls[0];
            expect(url).toBe('https://auth.atlassian.com/oauth/token');
            expect(opts.method).toBe('POST');
            expect(opts.body).toContain('grant_type=authorization_code');
            expect(opts.body).toContain('code=the-code');
        });

        test('4xx → JiraTokenExchangeError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(400, { body: { error: 'invalid_grant' } }));
            await expect(client.exchangeCodeForTokens('bad')).rejects.toThrow(JiraTokenExchangeError);
        });

        test('respuesta sin refresh_token → JiraTokenExchangeError', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ access_token: 'AT' }));
            await expect(client.exchangeCodeForTokens('x')).rejects.toThrow(JiraTokenExchangeError);
        });
    });

    describe('refreshAccessToken', () => {
        test('happy path devuelve nuevo access + nuevo refresh', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }));
            const result = await client.refreshAccessToken('old-RT');
            expect(result).toEqual({ accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 });
            expect(global.fetch.mock.calls[0][1].body).toContain('grant_type=refresh_token');
        });

        test('401 → JiraReconnectRequiredError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(401));
            await expect(client.refreshAccessToken('old-RT')).rejects.toThrow(JiraReconnectRequiredError);
        });

        test('400 invalid_grant en el body → JiraReconnectRequiredError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(400, { body: { error: 'invalid_grant' } }));
            await expect(client.refreshAccessToken('old-RT')).rejects.toThrow(JiraReconnectRequiredError);
        });
    });

    describe('revokeRefreshToken', () => {
        test('best effort: 200 → true', async () => {
            global.fetch.mockResolvedValueOnce(okJson({}, { status: 200 }));
            await expect(client.revokeRefreshToken('RT')).resolves.toBe(true);
        });

        test('best effort: error de red → false (no lanza)', async () => {
            global.fetch.mockRejectedValueOnce(new Error('network down'));
            await expect(client.revokeRefreshToken('RT')).resolves.toBe(false);
        });
    });

    describe('getAccessibleResources', () => {
        test('devuelve la lista de sites', async () => {
            global.fetch.mockResolvedValueOnce(okJson([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]));
            const result = await client.getAccessibleResources('AT');
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('cloud-1');
            expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer AT');
        });

        test('respuesta no-array → []', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ not: 'an array' }));
            await expect(client.getAccessibleResources('AT')).resolves.toEqual([]);
        });
    });

    describe('searchIssuesUpdatedInRange', () => {
        test('recorre la paginación con nextPageToken hasta isLast', async () => {
            global.fetch
                .mockResolvedValueOnce(okJson({ isLast: false, nextPageToken: 'tok-2', issues: new Array(50).fill(0).map((_, i) => ({ key: `P-${i}` })) }))
                .mockResolvedValueOnce(okJson({ isLast: true, issues: [{ key: 'P-50' }, { key: 'P-51' }] }));
            const issues = await client.searchIssuesUpdatedInRange('cloud-1', 'AT', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z');
            expect(issues).toHaveLength(52);
            expect(global.fetch).toHaveBeenCalledTimes(2);

            const firstUrl = new URL(global.fetch.mock.calls[0][0]);
            expect(firstUrl.pathname).toBe('/ex/jira/cloud-1/rest/api/3/search/jql');
            expect(firstUrl.searchParams.get('jql')).toContain('assignee = currentUser()');
            expect(firstUrl.searchParams.has('nextPageToken')).toBe(false);
            expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get('nextPageToken')).toBe('tok-2');
        });

        test('una sola página cuando isLast=true en la primera respuesta', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ isLast: true, issues: [{ key: 'P-1' }, { key: 'P-2' }] }));
            const issues = await client.searchIssuesUpdatedInRange('c', 'AT', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z');
            expect(issues).toHaveLength(2);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('corta cuando no viene nextPageToken aunque isLast no sea true', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ issues: [{ key: 'P-1' }] }));
            const issues = await client.searchIssuesUpdatedInRange('c', 'AT', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z');
            expect(issues).toHaveLength(1);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('401 → JiraReconnectRequiredError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(401));
            await expect(client.searchIssuesUpdatedInRange('c', 'AT', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z'))
                .rejects.toThrow(JiraReconnectRequiredError);
        });
    });

    describe('getMyself', () => {
        test('happy path mapea accountId / emailAddress / displayName', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ accountId: 'acc-1', emailAddress: 'me@acme.com', displayName: 'Me' }));
            const result = await client.getMyself('cloud-1', 'AT');
            expect(result).toEqual({ accountId: 'acc-1', emailAddress: 'me@acme.com', displayName: 'Me' });
            expect(global.fetch.mock.calls[0][0]).toContain('/ex/jira/cloud-1/rest/api/3/myself');
        });

        test('respuesta parcial → campos faltantes en null', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ accountId: 'acc-1' }));
            await expect(client.getMyself('c', 'AT')).resolves.toEqual({ accountId: 'acc-1', emailAddress: null, displayName: null });
        });

        test('401 → JiraReconnectRequiredError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(401));
            await expect(client.getMyself('c', 'AT')).rejects.toThrow(JiraReconnectRequiredError);
        });

        test('404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.getMyself('c', 'AT')).rejects.toThrow(JiraUpstreamError);
        });
    });

    describe('getChangelog / getComments / getWorklogs', () => {
        test('getChangelog devuelve values[] y construye la URL correcta', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ total: 1, values: [{ id: 'h1' }] }));
            const result = await client.getChangelog('cloud-9', 'AT', 'PROJ-1');
            expect(result).toEqual([{ id: 'h1' }]);
            expect(global.fetch.mock.calls[0][0]).toContain('/ex/jira/cloud-9/rest/api/3/issue/PROJ-1/changelog?');
        });

        test('getComments devuelve comments[]', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ total: 1, comments: [{ id: 'c1' }] }));
            await expect(client.getComments('c', 'AT', 'PROJ-1')).resolves.toEqual([{ id: 'c1' }]);
        });

        test('getWorklogs devuelve worklogs[]', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ total: 1, worklogs: [{ id: 'w1' }] }));
            await expect(client.getWorklogs('c', 'AT', 'PROJ-1')).resolves.toEqual([{ id: 'w1' }]);
        });

        test('getChangelog 401 → JiraReconnectRequiredError; 404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(401));
            await expect(client.getChangelog('c', 'AT', 'P-1')).rejects.toThrow(JiraReconnectRequiredError);
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.getChangelog('c', 'AT', 'P-1')).rejects.toThrow(JiraUpstreamError);
        });

        test('getComments 403 → JiraReconnectRequiredError; 404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(403));
            await expect(client.getComments('c', 'AT', 'P-1')).rejects.toThrow(JiraReconnectRequiredError);
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.getComments('c', 'AT', 'P-1')).rejects.toThrow(JiraUpstreamError);
        });

        test('getWorklogs 401 → JiraReconnectRequiredError; 404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(401));
            await expect(client.getWorklogs('c', 'AT', 'P-1')).rejects.toThrow(JiraReconnectRequiredError);
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.getWorklogs('c', 'AT', 'P-1')).rejects.toThrow(JiraUpstreamError);
        });

        test('paginación de changelog: 2 páginas', async () => {
            global.fetch
                .mockResolvedValueOnce(okJson({ total: 150, values: new Array(100).fill(0).map((_, i) => ({ id: `h${i}` })) }))
                .mockResolvedValueOnce(okJson({ total: 150, values: [{ id: 'h100' }] }));
            const result = await client.getChangelog('c', 'AT', 'P-1');
            expect(result).toHaveLength(101);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('search / accessible-resources error branches', () => {
        test('searchIssuesUpdatedInRange 404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.searchIssuesUpdatedInRange('c', 'AT', '2026-05-10T09:00:00Z', '2026-05-10T18:00:00Z'))
                .rejects.toThrow(JiraUpstreamError);
        });

        test('getAccessibleResources 404 → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(404));
            await expect(client.getAccessibleResources('AT')).rejects.toThrow(JiraUpstreamError);
        });

        test('exchangeCodeForTokens con body que no es JSON → JiraTokenExchangeError', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => { throw new Error('not json'); },
            });
            await expect(client.exchangeCodeForTokens('C')).rejects.toThrow(JiraTokenExchangeError);
        });

        test('refreshAccessToken !ok sin invalid_grant → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(errResponse(400, { body: { error: 'invalid_request' } }));
            await expect(client.refreshAccessToken('RT')).rejects.toThrow(JiraUpstreamError);
        });

        test('refreshAccessToken ok pero sin tokens → JiraUpstreamError', async () => {
            global.fetch.mockResolvedValueOnce(okJson({ access_token: 'AT' }));
            await expect(client.refreshAccessToken('RT')).rejects.toThrow(JiraUpstreamError);
        });
    });

    describe('retry / timeout', () => {
        test('5xx se reintenta 2 veces (3 attempts) y luego lanza JiraUpstreamError', async () => {
            global.fetch.mockResolvedValue(errResponse(503));
            await expect(client.getAccessibleResources('AT')).rejects.toThrow(JiraUpstreamError);
            expect(global.fetch).toHaveBeenCalledTimes(3);
        });

        test('5xx transitorio: 503 una vez y luego 200', async () => {
            global.fetch
                .mockResolvedValueOnce(errResponse(503))
                .mockResolvedValueOnce(okJson([{ id: 'c1' }]));
            const result = await client.getAccessibleResources('AT');
            expect(result).toEqual([{ id: 'c1' }]);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        test('429: respeta el retry y reintenta una vez', async () => {
            global.fetch
                .mockResolvedValueOnce(errResponse(429, { retryAfter: '0' }))
                .mockResolvedValueOnce(okJson([{ id: 'c1' }]));
            const result = await client.getAccessibleResources('AT');
            expect(result).toEqual([{ id: 'c1' }]);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        test('timeout: aborta, reintenta 1 vez y luego JiraTimeoutError', async () => {
            config.requestTimeoutMs = 10;
            global.fetch.mockImplementation((url, opts) => new Promise((_resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    const e = new Error('The operation was aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            }));
            await expect(client.getAccessibleResources('AT')).rejects.toThrow(JiraTimeoutError);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        }, 10000);
    });
});
