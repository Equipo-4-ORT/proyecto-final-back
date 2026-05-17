const errors = require('../../../src/modules/jira/jira.errors');

const {
    JiraError,
    JiraUserNotFoundError,
    JiraNotConnectedError,
    JiraReconnectRequiredError,
    JiraInvalidWindowError,
    JiraTokenExchangeError,
    JiraTimeoutError,
    JiraUpstreamError,
} = errors;

describe('jira.errors', () => {
    const cases = [
        [JiraError, 500, 'jira_error'],
        [JiraUserNotFoundError, 404, 'user_not_found'],
        [JiraNotConnectedError, 409, 'not_connected'],
        [JiraReconnectRequiredError, 409, 'reconnect_required'],
        [JiraInvalidWindowError, 400, 'invalid_window'],
        [JiraTokenExchangeError, 502, 'token_exchange_failed'],
        [JiraTimeoutError, 504, 'upstream_timeout'],
        [JiraUpstreamError, 502, 'upstream_error'],
    ];

    test.each(cases)('%p tiene status y code, es instanceof JiraError, y respeta el mensaje custom', (ErrorClass, status, code) => {
        const withDefault = new ErrorClass();
        expect(withDefault).toBeInstanceOf(JiraError);
        expect(withDefault).toBeInstanceOf(Error);
        expect(withDefault.status).toBe(status);
        expect(withDefault.code).toBe(code);
        expect(withDefault.name).toBe(ErrorClass.name);
        expect(typeof withDefault.message).toBe('string');

        const custom = new ErrorClass('mensaje personalizado', { cause: new Error('root') });
        expect(custom.message).toBe('mensaje personalizado');
        expect(custom.cause).toBeInstanceOf(Error);
    });
});
