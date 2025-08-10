const express = require('express');
const axios = require('axios');
const metricsMiddleware = require('./metricsMiddleware');
const client = require('./metrics').client;
const morgan = require('morgan');
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

const port = process.env.PORT || 3002;

let orders = [];

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

app.post('/orders', async (req, res) => {
  const { userId, product } = req.body;
  
  // Validate required fields
  if (!userId || !product) {
    logger.warn('Order creation request missing required fields', {
      route: '/orders',
      userId: userId || 'missing',
      product: product || 'missing',
      requestBody: req.body
    });
    return res.status(400).send({ 
      error: 'Missing required fields: userId and product are required' 
    });
  }

  logger.info('Creating new order', {
    userId,
    product: typeof product === 'object' ? product.name || 'unnamed' : product,
    route: '/orders'
  });

  try {
    const userServiceStart = Date.now();
    logger.debug('Fetching user data from user service', { 
      userId,
      userServiceUrl: `http://user-service:3001/users/${userId}`
    });

    const user = await axios.get(`http://user-service:3001/users/${userId}`, {
      timeout: 5000
    });
    
    const userServiceDuration = Date.now() - userServiceStart;
    logger.info('User data retrieved successfully', {
      userId,
      userName: user.data.name,
      userServiceResponseTime: `${userServiceDuration}ms`
    });

    const order = { 
      id: orders.length + 1, 
      user: user.data, 
      product,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    
    orders.push(order);

    logger.info('Order created successfully', {
      orderId: order.id,
      userId,
      userName: user.data.name,
      product: typeof product === 'object' ? product.name || 'unnamed' : product,
      totalOrders: orders.length
    });

    res.status(201).send(order);
  } catch (err) {
    logger.logError(err, {
      route: '/orders',
      userId,
      product,
      userServiceUrl: `http://user-service:3001/users/${userId}`,
      errorType: 'user_service_error'
    });

    // Determine specific error response based on error type
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      logger.error('User service unavailable', {
        userId,
        errorCode: err.code,
        message: err.message
      });
      return res.status(503).send({ 
        error: 'User service unavailable. Please try again later.' 
      });
    } else if (err.response?.status === 404) {
      logger.warn('User not found', {
        userId,
        userServiceStatus: err.response.status
      });
      return res.status(404).send({ 
        error: `User with ID ${userId} not found` 
      });
    } else if (err.code === 'ECONNABORTED') {
      logger.error('User service timeout', {
        userId,
        timeout: '5000ms'
      });
      return res.status(504).send({ 
        error: 'User service request timed out' 
      });
    }

    res.status(500).send({ 
      error: 'Failed to create order due to user service error' 
    });
  }
});

app.get('/orders', (req, res) => {
  logger.info('Retrieving all orders', {
    route: '/orders',
    totalOrders: orders.length,
    method: 'GET'
  });

  // Add some useful filtering options
  const { userId, status, limit } = req.query;
  let filteredOrders = [...orders];

  if (userId) {
    filteredOrders = filteredOrders.filter(order => order.user.id == userId);
    logger.debug('Filtered orders by userId', { 
      userId, 
      filteredCount: filteredOrders.length 
    });
  }

  if (status) {
    filteredOrders = filteredOrders.filter(order => order.status === status);
    logger.debug('Filtered orders by status', { 
      status, 
      filteredCount: filteredOrders.length 
    });
  }

  if (limit) {
    const limitNum = parseInt(limit);
    if (!isNaN(limitNum) && limitNum > 0) {
      filteredOrders = filteredOrders.slice(0, limitNum);
      logger.debug('Limited orders result', { 
        limit: limitNum, 
        returnedCount: filteredOrders.length 
      });
    }
  }

  logger.info('Orders retrieved successfully', {
    totalOrders: orders.length,
    filteredOrders: filteredOrders.length,
    filters: { userId, status, limit }
  });

  res.send({
    orders: filteredOrders,
    total: orders.length,
    filtered: filteredOrders.length
  });
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
    await axios.get('http://order-service:3002/health', { timeout: 1000 });
    const healthCheckDuration = Date.now() - healthCheckStart;
    
    logger.info('Health check successful', {
      endpoint: '/health',
      dependencyCheck: 'order-service:3002',
      responseTime: `${healthCheckDuration}ms`,
      ordersInMemory: orders.length
    });
    
    return res.send({ 
      status: 'ok', 
      deps: { orderService: 'ok' },
      ordersCount: orders.length
    });
  } catch (error) {
    logger.warn('Health check failed - service degraded', {
      endpoint: '/health',
      dependencyCheck: 'order-service:3002',
      error: error.message,
      errorCode: error.code,
      timeout: '1000ms'
    });
    
    return res.status(503).send({ 
      status: 'degraded', 
      deps: { orderService: 'down' },
      ordersCount: orders.length
    });
  }
});

// Additional endpoint to get order by ID
app.get('/orders/:id', (req, res) => {
  const orderId = parseInt(req.params.id);
  
  logger.info('Retrieving specific order', {
    orderId,
    route: '/orders/:id'
  });

  if (isNaN(orderId)) {
    logger.warn('Invalid order ID provided', {
      providedId: req.params.id,
      route: '/orders/:id'
    });
    return res.status(400).send({ error: 'Invalid order ID' });
  }

  const order = orders.find(o => o.id === orderId);

  if (!order) {
    logger.warn('Order not found', {
      orderId,
      availableOrderIds: orders.map(o => o.id)
    });
    return res.status(404).send({ error: 'Order not found' });
  }

  logger.info('Order retrieved successfully', {
    orderId,
    userId: order.user.id,
    userName: order.user.name
  });

  res.send(order);
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
  logger.info('Order service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid,
    service: 'order-service'
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`, {
    service: 'order-service',
    ordersInMemory: orders.length
  });
  
  server.close((err) => {
    if (err) {
      logger.logError(err, { context: 'Graceful shutdown failed' });
      process.exit(1);
    }
    
    logger.info('Order service closed successfully', {
      ordersInMemory: orders.length
    });
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
  logger.logError(error, { context: 'Uncaught Exception', service: 'order-service' });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise.toString(),
    service: 'order-service'
  });
});