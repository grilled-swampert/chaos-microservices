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
  const { userId, product, amount } = req.body;
  
  // Validate required fields
  if (!userId || !product || !amount) {
    logger.warn('Order creation request missing required fields', {
      route: '/orders',
      userId: userId || 'missing',
      product: product || 'missing',
      amount: amount || 'missing',
      requestBody: req.body
    });
    return res.status(400).send({ 
      error: 'Missing required fields: userId, product, and amount are required' 
    });
  }

  logger.info('Creating new order', {
    userId,
    product: typeof product === 'object' ? product.name || 'unnamed' : product,
    amount,
    route: '/orders'
  });

  try {
    const userServiceStart = Date.now();
    logger.debug('Fetching user data from user service', { 
      userId,
      userServiceUrl: `http://microservices.local/users/${userId}`
    });

    const user = await axios.get(`http://microservices.local/users/${userId}`, {
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
      amount: parseFloat(amount),
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    
    orders.push(order);

    logger.info('Order created successfully', {
      orderId: order.id,
      userId,
      userName: user.data.name,
      product: typeof product === 'object' ? product.name || 'unnamed' : product,
      amount: order.amount,
      totalOrders: orders.length
    });

    res.status(201).send(order);
  } catch (err) {
    logger.logError(err, {
      route: '/orders',
      userId,
      product,
      amount,
      userServiceUrl: `http://microservices.local/users/${userId}`,
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

// NEW: Process payment for an order
app.post('/orders/:id/pay', async (req, res) => {
  const orderId = parseInt(req.params.id);
  
  logger.info('Processing payment for order', {
    orderId,
    route: '/orders/:id/pay'
  });

  if (isNaN(orderId)) {
    logger.warn('Invalid order ID for payment', {
      providedId: req.params.id
    });
    return res.status(400).send({ error: 'Invalid order ID' });
  }

  const order = orders.find(o => o.id === orderId);

  if (!order) {
    logger.warn('Order not found for payment', {
      orderId
    });
    return res.status(404).send({ error: 'Order not found' });
  }

  if (order.status === 'paid') {
    logger.warn('Order already paid', {
      orderId,
      currentStatus: order.status
    });
    return res.status(400).send({ error: 'Order already paid' });
  }

  try {
    // Call payment service
    const paymentStart = Date.now();
    const paymentResponse = await axios.post('http://microservices.local/payment/', {
      orderId: orderId,
      amount: order.amount,
      userId: order.user.id
    }, { timeout: 10000 });

    const paymentDuration = Date.now() - paymentStart;
    
    // Update order status
    order.status = 'paid';
    order.paymentDetails = paymentResponse.data;
    order.paidAt = new Date().toISOString();

    logger.info('Order payment processed successfully', {
      orderId,
      transactionId: paymentResponse.data.transactionId,
      amount: order.amount,
      paymentServiceResponseTime: `${paymentDuration}ms`
    });

    res.send({
      order,
      payment: paymentResponse.data
    });

  } catch (err) {
    logger.logError(err, {
      route: '/orders/:id/pay',
      orderId,
      amount: order.amount,
      errorType: 'payment_service_error'
    });

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(503).send({ 
        error: 'Payment service unavailable. Please try again later.' 
      });
    } else if (err.code === 'ECONNABORTED') {
      return res.status(504).send({ 
        error: 'Payment service request timed out' 
      });
    }

    res.status(500).send({ 
      error: 'Failed to process payment' 
    });
  }
});

// NEW: Get order analytics with user demographics
app.get('/analytics/orders', async (req, res) => {
  logger.info('Generating order analytics', {
    route: '/analytics/orders'
  });

  try {
    // Get user demographics for analytics
    const userPromises = orders.map(order => 
      axios.get(`http://microservices.local/users/${order.user.id}/profile`, {
        timeout: 3000
      }).catch(err => {
        logger.warn('Failed to fetch user profile for analytics', {
          userId: order.user.id,
          error: err.message
        });
        return { data: { demographics: 'unknown' } };
      })
    );

    const userProfiles = await Promise.all(userPromises);

    const analytics = {
      totalOrders: orders.length,
      ordersByStatus: orders.reduce((acc, order) => {
        acc[order.status] = (acc[order.status] || 0) + 1;
        return acc;
      }, {}),
      totalRevenue: orders.filter(o => o.status === 'paid').reduce((sum, o) => sum + o.amount, 0),
      averageOrderValue: orders.length > 0 ? orders.reduce((sum, o) => sum + o.amount, 0) / orders.length : 0,
      userDemographics: userProfiles.map(p => p.data.demographics || 'unknown'),
      generatedAt: new Date().toISOString()
    };

    logger.info('Order analytics generated successfully', {
      totalOrders: analytics.totalOrders,
      totalRevenue: analytics.totalRevenue
    });

    res.send(analytics);

  } catch (err) {
    logger.logError(err, {
      route: '/analytics/orders',
      errorType: 'analytics_generation_error'
    });

    res.status(500).send({
      error: 'Failed to generate analytics'
    });
  }
});

// NEW: Cancel order endpoint
app.delete('/orders/:id', async (req, res) => {
  const orderId = parseInt(req.params.id);
  
  logger.info('Cancelling order', {
    orderId,
    route: 'DELETE /orders/:id'
  });

  if (isNaN(orderId)) {
    return res.status(400).send({ error: 'Invalid order ID' });
  }

  const orderIndex = orders.findIndex(o => o.id === orderId);
  if (orderIndex === -1) {
    return res.status(404).send({ error: 'Order not found' });
  }

  const order = orders[orderIndex];
  if (order.status === 'paid') {
    try {
      // Notify payment service about refund
      await axios.post('http://microservices.local/payment/refund', {
        transactionId: order.paymentDetails?.transactionId,
        amount: order.amount
      }, { timeout: 5000 });
      
      logger.info('Refund processed for cancelled order', {
        orderId,
        transactionId: order.paymentDetails?.transactionId
      });
    } catch (err) {
      logger.error('Failed to process refund', {
        orderId,
        error: err.message
      });
    }
  }

  orders.splice(orderIndex, 1);
  
  logger.info('Order cancelled successfully', {
    orderId,
    previousStatus: order.status
  });

  res.send({ message: 'Order cancelled successfully', cancelledOrder: order });
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

const services = {
  userService: 'http://user-service:3001/ready',
  paymentService: 'http://payment-service:3003/ready',
  orderService: 'http://order-service:3002/ready' // add more as needed
};


app.get('/health', async (req, res) => {
  const results = await Promise.allSettled(
    Object.entries(services).map(([key, url]) =>
      axios.get(url, { timeout: 3000 })
        .then(() => ({ service: key, status: "ok" }))
        .catch(err => ({
          service: key,
          status: 'down',
          error: {
            message: err.message,
            code: err.code,
            statusCode: err.response?.status
          }
        }))
    )
  );

  const safeResults = results.map(r => r.value || r.reason);

  const statusReport = Object.keys(services).reduce((acc, key, i) => {
    acc[key] = results[i].status === "fulfilled" ? 'ok' : 'down';
    return acc;
  }, {});

  res.status(200).send({
    status: Object.values(statusReport).every(s => s === 'ok') ? 'ok' : 'partial',
    status_results: safeResults,
    services: statusReport,
    deps: statusReport,
    ordersCount: orders.length
  });
});

app.get('/ready', (req, res) => res.sendStatus(200));

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