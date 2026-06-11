class AIParseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AIParseError';
  }
}

class AIValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AIValidationError';
  }
}

module.exports = { AIParseError, AIValidationError };
