const requestLogger = require('./requestLogger');
const errorHandler = require('./errorHandler');
const requireRole = require('./requireRole')

module.exports = {
  requestLogger,
  errorHandler,
  requireRole
};
