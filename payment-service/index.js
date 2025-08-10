const express = require('express');
const axios = require('axios');
const metricsMiddleware = require('./metricsMiddleware');
const logger = require('./logger');
const morgan = require('morgan');
const client = require('./metrics').client;

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

const port = process.env.PORT || 3003;

// Middleware to log every request
app.use((req, res, next) => {
  const startTime = Date.now();
  
  logger.info('Incoming request', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent')
  });

  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - startTime;
    logger.logRequest(req, res, duration);
    originalEnd.apply(this, args);
  };

  next();
});

app.post('/pay', (req, res) => {
  const { orderId, amount } = req.body;
  
  // Validate required fields
  if (!orderId || !amount) {
    logger.warn('Payment request missing required fields', {
      route: '/pay',
      orderId: orderId || 'missing',
      amount: amount || 'missing',
      requestBody: req.body
    });
    return res.status(400).send({ 
      error: 'Missing required fields: orderId and amount are required' 
    });
  }

  // Validate amount is a positive number
  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    logger.warn('Invalid payment amount', {
      route: '/pay',
      orderId,
      amount,
      numericAmount
    });
    return res.status(400).send({ 
      error: 'Invalid amount: must be a positive number' 
    });
  }

  logger.info('Processing payment', {
    orderId,
    amount: numericAmount,
    currency: '₹',
    route: '/pay'
  });

  // Simulate payment processing time
  const processingStart = Date.now();
  
  // In a real application, this would involve actual payment processing
  // For now, we'll simulate success
  const paymentResult = { 
    status: 'paid', 
    orderId, 
    amount: numericAmount,
    transactionId: `txn_${Date.now()}_${orderId}`,
    processedAt: new Date().toISOString()
  };

  const processingDuration = Date.now() - processingStart;

  logger.info('Payment processed successfully', {
    orderId,
    amount: numericAmount,
    transactionId: paymentResult.transactionId,
    processingTime: `${processingDuration}ms`,
    route: '/pay'
  });

  res.send(paymentResult);
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
    await axios.get('http://payment-service:3003/health', { timeout: 1000 });
    const healthCheckDuration = Date.now() - healthCheckStart;
    
    logger.info('Health check successful', {
      endpoint: '/health',
      dependencyCheck: 'payment-service:3003',
      responseTime: `${healthCheckDuration}ms`
    });
    
    return res.send({ status: 'ok', deps: { paymentService: 'ok' }});
  } catch (error) {
    logger.warn('Health check failed - service degraded', {
      endpoint: '/health',
      dependencyCheck: 'payment-service:3003',
      error: error.message,
      errorCode: error.code,
      timeout: '1000ms'
    });
    
    return res.status(503).send({ status: 'degraded', deps: { paymentService: 'down' }});
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
  logger.info('Payment service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid,
    service: 'payment-service'
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`, {
    service: 'payment-service'
  });
  
  server.close((err) => {
    if (err) {
      logger.logError(err, { context: 'Graceful shutdown failed' });
      process.exit(1);
    }
    
    logger.info('Payment service closed successfully');
    process.exit(0);
  });
  
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.logError(error, { context: 'Uncaught Exception', service: 'payment-service' });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise.toString(),
    service: 'payment-service'
  });
});