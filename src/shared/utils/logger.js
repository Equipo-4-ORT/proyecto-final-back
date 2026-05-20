const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

const { combine, timestamp, colorize, printf, errors, splat, json } = format;

const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}]: ${stack || message}${extra}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    splat(),
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), consoleFormat),
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: json(),
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: json(),
    }),
  ],
});

module.exports = logger;
