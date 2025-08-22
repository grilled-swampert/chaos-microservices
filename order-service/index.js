const express = require('express');
const { Pool } = require('pg');
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

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-service',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'ecommerce',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
});

// Initialize database tables
async function initDB(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected successfully', {
        host: process.env.DB_HOST || 'postgres-service',
        database: process.env.DB_NAME || 'ecommerce'
      });
      return pool;
    } catch (err) {
      logger.warn(`DB connection failed, retrying in 5s... (attempt ${i + 1}/${retries})`, {
        error: err.message,
        host: process.env.DB_HOST || 'postgres-service'
      });
      await new Promise(res => setTimeout(res, 5000));
    }
  }
  throw new Error('Could not connect to DB');
}

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

// Create new order
app.post('/orders', async (req, res) => {
  try {
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
      return res.status(400).json({
        error: 'Missing required fields: userId, product, and amount are required'
      });
    }

    logger.info('Creating new order', {
      userId,
      product: typeof product === 'object' ? product.name || 'unnamed' : product,
      amount,
      route: '/orders'
    });

    // Get user data from user service
    const userServiceStart = Date.now();
    logger.debug('Fetching user data from user service', { 
      userId,
      userServiceUrl: `http://user-service:3001/users/${userId}`
    });

    const userResponse = await axios.get(`http://user-service:3001/users/${userId}`, {
      timeout: 5000
    });

    const userServiceDuration = Date.now() - userServiceStart;
    logger.info('User data retrieved successfully', {
      userId,
      userName: userResponse.data.name,
      userServiceResponseTime: `${userServiceDuration}ms`
    });

    // Create order in database
    const result = await pool.query(`
      INSERT INTO orders (user_id, user_data, product, amount)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [userId, JSON.stringify(userResponse.data), product, parseFloat(amount)]);

    logger.info('Order created successfully', {
      orderId: result.rows[0].id,
      userId,
      userName: userResponse.data.name,
      product: typeof product === 'object' ? product.name || 'unnamed' : product,
      amount: parseFloat(amount)
    });

    res.status(201).json(result.rows[0]);

  } catch (error) {
    logger.logError(error, {
      route: '/orders',
      userId: req.body.userId,
      product: req.body.product,
      amount: req.body.amount,
      errorType: 'order_creation_error'
    });

    if (error.response?.status === 404) {
      logger.warn('User not found', {
        userId: req.body.userId,
        userServiceStatus: error.response.status
      });
      return res.status(404).json({ error: `User with ID ${req.body.userId} not found` });
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      logger.error('User service unavailable', {
        userId: req.body.userId,
        errorCode: error.code
      });
      return res.status(503).json({ error: 'User service unavailable' });
    }
    if (error.code === 'ECONNABORTED') {
      logger.error('User service timeout', {
        userId: req.body.userId,
        timeout: '5000ms'
      });
      return res.status(504).json({ error: 'User service request timed out' });
    }
    
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get all orders with filtering
app.get('/orders', async (req, res) => {
  try {
    const { userId, status, limit = 20, offset = 0 } = req.query;
    
    logger.info('Retrieving orders', {
      route: '/orders',
      filters: { userId, status, limit, offset },
      method: 'GET'
    });

    let query = 'SELECT * FROM orders';
    let params = [];
    let conditions = [];

    if (userId) {
      conditions.push(`user_id = $${params.length + 1}`);
      params.push(userId);
    }

    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Get total count for filtered results
    let countQuery = 'SELECT COUNT(*) FROM orders';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit and offset

    logger.info('Orders retrieved successfully', {
      totalOrders: parseInt(countResult.rows[0].count),
      filteredOrders: result.rows.length,
      filters: { userId, status, limit, offset }
    });

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].count),
      filtered: result.rows.length
    });
  } catch (error) {
    logger.logError(error, {
      route: '/orders',
      errorType: 'orders_retrieval_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order by ID
app.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = parseInt(id);
    
    logger.info('Retrieving specific order', {
      orderId,
      route: '/orders/:id'
    });
    
    if (isNaN(orderId)) {
      logger.warn('Invalid order ID provided', {
        providedId: id,
        route: '/orders/:id'
      });
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      logger.warn('Order not found', {
        orderId
      });
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = result.rows[0];
    logger.info('Order retrieved successfully', {
      orderId,
      userId: order.user_id,
      status: order.status
    });

    res.json(order);
  } catch (error) {
    logger.logError(error, {
      route: '/orders/:id',
      orderId: req.params.id,
      errorType: 'single_order_retrieval_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Process payment for order
app.post('/orders/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = parseInt(id);
    
    logger.info('Processing payment for order', {
      orderId,
      route: '/orders/:id/pay'
    });
    
    if (isNaN(orderId)) {
      logger.warn('Invalid order ID for payment', {
        providedId: id
      });
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // Get order
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      logger.warn('Order not found for payment', {
        orderId
      });
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    
    if (order.status === 'paid') {
      logger.warn('Order already paid', {
        orderId,
        currentStatus: order.status
      });
      return res.status(400).json({ error: 'Order already paid' });
    }

    // Process payment through payment service
    const paymentStart = Date.now();
    const paymentResponse = await axios.post('http://payment-service:3003/pay', {
      orderId: order.id,
      amount: order.amount,
      userId: order.user_id
    }, { timeout: 10000 });

    const paymentDuration = Date.now() - paymentStart;

    // Update order status
    const updateResult = await pool.query(`
      UPDATE orders 
      SET status = 'paid', 
          payment_details = $2, 
          paid_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, JSON.stringify(paymentResponse.data)]);

    logger.info('Order payment processed successfully', {
      orderId,
      transactionId: paymentResponse.data.transactionId,
      amount: order.amount,
      paymentServiceResponseTime: `${paymentDuration}ms`
    });
    
    res.json({
      order: updateResult.rows[0],
      payment: paymentResponse.data
    });

  } catch (error) {
    logger.logError(error, {
      route: '/orders/:id/pay',
      orderId: req.params.id,
      errorType: 'payment_processing_error'
    });

    if (error.response?.status === 402) {
      return res.status(402).json({ error: 'Payment failed: ' + error.response.data.error });
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Payment service unavailable' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Payment service request timed out' });
    }
    
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Cancel order
app.delete('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orderId = parseInt(id);
    
    logger.info('Cancelling order', {
      orderId,
      route: 'DELETE /orders/:id'
    });
    
    if (isNaN(orderId)) {
      logger.warn('Invalid order ID for cancellation', {
        providedId: id
      });
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // Get order
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      logger.warn('Order not found for cancellation', {
        orderId
      });
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // If order was paid, process refund
    if (order.status === 'paid' && order.payment_details) {
      try {
        await axios.post('http://payment-service:3003/refund', {
          transactionId: JSON.parse(order.payment_details).transactionId,
          amount: order.amount,
          reason: 'order_cancellation'
        }, { timeout: 5000 });
        
        logger.info('Refund processed for cancelled order', {
          orderId,
          transactionId: JSON.parse(order.payment_details).transactionId
        });
      } catch (error) {
        logger.error('Failed to process refund', {
          orderId,
          error: error.message
        });
      }
    }

    // Delete order
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    
    logger.info('Order cancelled successfully', {
      orderId,
      previousStatus: order.status
    });

    res.json({ message: 'Order cancelled successfully', cancelledOrder: order });

  } catch (error) {
    logger.logError(error, {
      route: 'DELETE /orders/:id',
      orderId: req.params.id,
      errorType: 'order_cancellation_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order analytics with user demographics
app.get('/analytics/orders', async (req, res) => {
  try {
    logger.info('Generating order analytics', {
      route: '/analytics/orders'
    });

    const totalOrdersResult = await pool.query('SELECT COUNT(*) FROM orders');
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as count, SUM(amount) as revenue
      FROM orders 
      GROUP BY status
    `);
    const avgResult = await pool.query('SELECT AVG(amount) as avg_order_value FROM orders');

    // Get user demographics for analytics
    const ordersResult = await pool.query('SELECT user_id FROM orders');
    const userPromises = ordersResult.rows.map(order => 
      axios.get(`http://user-service:3001/users/${order.user_id}/profile`, {
        timeout: 3000
      }).catch(err => {
        logger.warn('Failed to fetch user profile for analytics', {
          userId: order.user_id,
          error: err.message
        });
        return { data: { demographics: 'unknown' } };
      })
    );

    const userProfiles = await Promise.all(userPromises);

    const analytics = {
      totalOrders: parseInt(totalOrdersResult.rows[0].count),
      ordersByStatus: {},
      totalRevenue: 0,
      averageOrderValue: parseFloat(avgResult.rows[0].avg_order_value) || 0,
      userDemographics: userProfiles.map(p => p.data.demographics || 'unknown'),
      generatedAt: new Date().toISOString()
    };

    statusResult.rows.forEach(row => {
      analytics.ordersByStatus[row.status] = parseInt(row.count);
      if (row.status === 'paid') {
        analytics.totalRevenue = parseFloat(row.revenue) || 0;
      }
    });

    logger.info('Order analytics generated successfully', {
      totalOrders: analytics.totalOrders,
      totalRevenue: analytics.totalRevenue
    });

    res.json(analytics);
  } catch (error) {
    logger.logError(error, {
      route: '/analytics/orders',
      errorType: 'analytics_generation_error'
    });
    res.status(500).json({ error: 'Failed to generate analytics' });
  }
});

// Metrics endpoint
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

app.post('/webhooks/user-updated', (req, res) => {
  const { userId, changes, timestamp } = req.body;
  console.log(`Received webhook: user ${userId} updated at ${timestamp}`, changes);
  // Handle update logic here (e.g., update order records)
  res.sendStatus(200);
});

// Health check with dependency checks
const services = {
  userService: 'http://user-service:3001/ready',
  paymentService: 'http://payment-service:3003/ready'
};

app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');
    
    // Check dependent services
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

    // Get order count from database
    const orderCountResult = await pool.query('SELECT COUNT(*) FROM orders');

    res.status(200).json({
      status: Object.values(statusReport).every(s => s === 'ok') ? 'ok' : 'partial',
      service: 'order-service',
      database: 'ok',
      status_results: safeResults,
      services: statusReport,
      deps: statusReport,
      ordersCount: parseInt(orderCountResult.rows[0].count)
    });

  } catch (error) {
    logger.logError(error, {
      endpoint: '/health',
      errorType: 'health_check_error'
    });
    res.status(500).json({ 
      status: 'error', 
      service: 'order-service', 
      error: 'Database connection failed' 
    });
  }
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

// Start server
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('Order service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid,
    service: 'order-service'
  });
  initDB().catch(err => {
    logger.logError(err, { context: 'Database initialization failed' });
    process.exit(1);
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`, {
    service: 'order-service'
  });
  
  server.close((err) => {
    if (err) {
      logger.logError(err, { context: 'Graceful shutdown failed' });
      process.exit(1);
    }
    
    pool.end();
    logger.info('Order service closed successfully');
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