const express = require('express');
const axios = require('axios');

const app = express();
const metricsMiddleware = require('./metricsMiddleware');
const morgan = require('morgan');
const logger = require('./logger');
const client = require('./metrics').client;

app.use(express.json());
app.use(metricsMiddleware);
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

const port = process.env.PORT || 3001;

const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
];

// Middleware to log every request
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log the incoming request
  logger.info('Incoming request', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent')
  });

  // Override res.end to log response details
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    logger.logRequest(req, res, duration);
    originalEnd.apply(this, args);
  };

  next();
});

app.get('/users/:id', (req, res) => {
  const userId = req.params.id;
  
  logger.info('User lookup requested', { 
    userId,
    route: '/users/:id'
  });

  const user = users.find(u => u.id == userId);

  if (!user) {
    logger.warn('User not found', { 
      userId,
      availableUserIds: users.map(u => u.id)
    });
    return res.status(404).send({ error: 'User not found' });
  }

  logger.info('User found successfully', { 
    userId,
    userName: user.name
  });
  
  res.send(user);
});

app.get('/metrics', async (req, res) => {
  logger.debug('Metrics endpoint accessed');
  
  try {
    const metrics = await client.register.metrics();
    res.set('Content-Type', client.register.contentType);
    res.send(metrics);
    
    logger.info('Metrics served successfully');
  } catch (error) {
    logger.logError(error, {
      endpoint: '/metrics',
      message: 'Failed to retrieve metrics'
    });
    res.status(500).send({ error: 'Failed to retrieve metrics' });
  }
});

app.get('/health', async (req, res) => {
  logger.debug('Health check initiated');
  
  try {
    const healthCheckStart = Date.now();
    await axios.get('http://user-service:3001/health', { timeout: 1000 });
    const healthCheckDuration = Date.now() - healthCheckStart;
    
    logger.info('Health check successful', {
      endpoint: '/health',
      dependencyCheck: 'user-service:3001',
      responseTime: `${healthCheckDuration}ms`
    });
    
    return res.send({ status: 'ok', deps: { userService: 'ok' }});
  } catch (error) {
    logger.warn('Health check failed - service degraded', {
      endpoint: '/health',
      dependencyCheck: 'user-service:3001',
      error: error.message,
      errorCode: error.code,
      timeout: '1000ms'
    });
    
    return res.status(503).send({ status: 'degraded', deps: { userService: 'down' }});
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.logError(error, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  res.status(500).send({ 
    error: 'Internal server error',
    requestId: req.id || 'unknown'
  });
});

// Handle 404 routes
app.use((req, res) => {
  logger.warn('Route not found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip
  });
  
  res.status(404).send({ 
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl
  });
});

// Graceful server startup
const server = app.listen(port, () => {
  logger.info('User service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  
  server.close((err) => {
    if (err) {
      logger.logError(err, { context: 'Graceful shutdown failed' });
      process.exit(1);
    }
    
    logger.info('Server closed successfully');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.logError(error, { context: 'Uncaught Exception' });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise.toString()
  });
});