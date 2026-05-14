/**
 * Errores tipados del módulo Jira.
 *
 * Cada subclase fija `status` para que el `errorHandler` global lo mapee al
 * status HTTP correcto (`err.status || 500`). Las subclases también llevan un
 * `code` legible que el frontend puede usar para mostrar mensajes específicos.
 *
 * Convención del repo: mensajes en español; encadenar la causa con `{ cause }`.
 */

class JiraError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.status = 500;
        this.code = 'jira_error';
    }
}

class JiraUserNotFoundError extends JiraError {
    constructor(message = 'El usuario no existe', options) {
        super(message, options);
        this.status = 404;
        this.code = 'user_not_found';
    }
}

class JiraInvalidStateError extends JiraError {
    constructor(message = 'El parámetro state es inválido o expiró', options) {
        super(message, options);
        this.status = 400;
        this.code = 'invalid_state';
    }
}

class JiraNotConnectedError extends JiraError {
    constructor(message = 'El usuario no tiene una conexión Jira activa', options) {
        super(message, options);
        this.status = 409;
        this.code = 'not_connected';
    }
}

class JiraReconnectRequiredError extends JiraError {
    constructor(message = 'La conexión a Jira expiró; reconectá tu cuenta', options) {
        super(message, options);
        this.status = 409;
        this.code = 'reconnect_required';
    }
}

class JiraInvalidWindowError extends JiraError {
    constructor(message = 'La ventana de tiempo es inválida', options) {
        super(message, options);
        this.status = 400;
        this.code = 'invalid_window';
    }
}

class JiraTokenExchangeError extends JiraError {
    constructor(message = 'Falló el intercambio del code OAuth con Atlassian', options) {
        super(message, options);
        this.status = 502;
        this.code = 'token_exchange_failed';
    }
}

class JiraNoSiteError extends JiraError {
    constructor(message = 'La cuenta de Atlassian no tiene un site Jira accesible', options) {
        super(message, options);
        this.status = 502;
        this.code = 'no_jira_site';
    }
}

class JiraTimeoutError extends JiraError {
    constructor(message = 'Timeout al comunicarse con Atlassian', options) {
        super(message, options);
        this.status = 504;
        this.code = 'upstream_timeout';
    }
}

class JiraUpstreamError extends JiraError {
    constructor(message = 'Error al comunicarse con Atlassian', options) {
        super(message, options);
        this.status = 502;
        this.code = 'upstream_error';
    }
}

module.exports = {
    JiraError,
    JiraUserNotFoundError,
    JiraInvalidStateError,
    JiraNotConnectedError,
    JiraReconnectRequiredError,
    JiraInvalidWindowError,
    JiraTokenExchangeError,
    JiraNoSiteError,
    JiraTimeoutError,
    JiraUpstreamError,
};
