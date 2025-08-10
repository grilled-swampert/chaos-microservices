const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom timestamp format
const timestampFormat = () => {
  return new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: true
  }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$1-$2');
};

// Custom format for console output (colorized)
const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: timestampFormat }),
  format.errors({ stack: true }),
  format.splat(),
  format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
    return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
  })
);

// Custom format for file output (JSON)
const fileFormat = format.combine(
  format.timestamp({ format: timestampFormat }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

// Create logger instance
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fileFormat,
  transports: [
    // Console transport with colors
    new transports.Console({
      format: consoleFormat,
      handleExceptions: true,
      handleRejections: true
    }),
    
    // Combined log file (info and above, excluding errors)
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      format: fileFormat,
      handleExceptions: true,
      handleRejections: true,
      // Filter out error level logs (they go to error.log)
      filter: (info) => info.level !== 'error'
    }),
    
    // Error log file (errors only)
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      format: fileFormat,
      handleExceptions: true,
      handleRejections: true
    }),
    
    // Debug log file (only when LOG_LEVEL is debug)
    ...(process.env.LOG_LEVEL === 'debug' ? [
      new transports.File({
        filename: path.join(logsDir, 'debug.log'),
        level: 'debug',
        maxsize: 5242880, // 5MB
        maxFiles: 3,
        format: fileFormat
      })
    ] : [])
  ],
  
  // Handle uncaught exceptions and unhandled rejections
  exceptionHandlers: [
    new transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      format: fileFormat,
      maxsize: 10485760,
      maxFiles: 3
    })
  ],
  
  rejectionHandlers: [
    new transports.File({
      filename: path.join(logsDir, 'rejections.log'),
      format: fileFormat,
      maxsize: 10485760,
      maxFiles: 3
    })
  ]
});

// Add helper methods for structured logging
logger.logRequest = (req, res, duration) => {
  logger.info('HTTP Request', {
    method: req.method,
    url: req.url,
    statusCode: res.statusCode,
    duration: `${duration}ms`,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress
  });
};

logger.logError = (error, context = {}) => {
  logger.error('Application Error', {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    ...context
  });
};

logger.logDatabaseQuery = (query, duration, rowCount) => {
  logger.debug('Database Query', {
    query: query.substring(0, 200) + (query.length > 200 ? '...' : ''),
    duration: `${duration}ms`,
    rowCount
  });
};

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Application shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Application terminated by SIGTERM');
  process.exit(0);
});

module.exports = logger;