const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const metricsMiddleware = require('./metricsMiddleware');
const client = require('./metrics').client;
const morgan = require('morgan');
const logger = require('./logger');
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { SimpleSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { JaegerExporter } = require("@opentelemetry/exporter-jaeger");

const provider = new NodeTracerProvider();
const exporter = new JaegerExporter({
  endpoint: "http://jaeger-collector.observability.svc.cluster.local:14268/api/traces",
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) }
}));

const port = process.env.PORT || 3003;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-service',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'ecommerce',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
});

// Initialize database tables
const initDB = async (retries = 5) => {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected successfully', {
        host: process.env.DB_HOST || 'postgres-service',
        database: process.env.DB_NAME || 'ecommerce'
      });
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
          id SERIAL PRIMARY KEY,
          transaction_id VARCHAR(100) UNIQUE NOT NULL,
          order_id INTEGER NOT NULL,
          user_id INTEGER,
          amount DECIMAL(10,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'paid',
          user_data JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS refunds (
          id SERIAL PRIMARY KEY,
          refund_id VARCHAR(100) UNIQUE NOT NULL,
          original_transaction_id VARCHAR(100) NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          reason VARCHAR(100),
          status VARCHAR(20) DEFAULT 'processed',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      logger.info('Payment service database initialized successfully');
      return pool;
    } catch (error) {
      logger.warn(`Database initialization failed, retrying in 5s... (attempt ${i + 1}/${retries})`, {
        error: error.message,
        host: process.env.DB_HOST || 'postgres-service'
      });
      await new Promise(res => setTimeout(res, 5000));
    }
  }
  throw new Error('Could not initialize database');
};

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
  res.end = function (...args) {
    const duration = Date.now() - startTime;
    logger.logRequest(req, res, duration);
    originalEnd.apply(this, args);
  };

  next();
});

// Process payment
app.post('/pay', async (req, res) => {
  try {
    const { orderId, amount, userId } = req.body;

    // Validate required fields
    if (!orderId || !amount) {
      logger.warn('Payment request missing required fields', {
        route: '/pay',
        orderId: orderId || 'missing',
        amount: amount || 'missing',
        userId: userId || 'missing',
        requestBody: req.body
      });
      return res.status(400).json({
        error: 'Missing required fields: orderId and amount are required'
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      logger.warn('Invalid payment amount', {
        route: '/pay',
        orderId,
        amount,
        numericAmount
      });
      return res.status(400).json({
        error: 'Invalid amount: must be a positive number'
      });
    }

    logger.info('Processing payment', {
      orderId,
      amount: numericAmount,
      userId,
      currency: '₹',
      route: '/pay'
    });

    // Simulate random payment failures (5% failure rate)
    const shouldFail = Math.random() < 0.05;
    if (shouldFail) {
      logger.warn('Simulated payment failure', {
        orderId,
        amount: numericAmount,
        userId,
        reason: 'insufficient_funds'
      });
      return res.status(402).json({
        error: 'Payment failed: Insufficient funds',
        orderId,
        amount: numericAmount
      });
    }

    // Get user information if userId provided
    let userData = null;
    if (userId) {
      try {
        const userServiceStart = Date.now();
        logger.debug('Fetching user data for payment', {
          userId,
          userServiceUrl: `http://user-service:3001/users/${userId}`
        });

        const userResponse = await axios.get(`http://user-service:3001/users/${userId}`, {
          timeout: 3000
        });
        userData = userResponse.data;

        const userServiceDuration = Date.now() - userServiceStart;
        logger.info('User information retrieved for payment', {
          userId,
          userName: userData.name,
          userServiceResponseTime: `${userServiceDuration}ms`
        });
      } catch (error) {
        logger.warn('Failed to retrieve user info for payment', {
          userId,
          error: error.message
        });
      }
    }

    // Create transaction in database
    const processingStart = Date.now();
    const transactionId = `txn_${Date.now()}_${orderId}`;
    const result = await pool.query(`
      INSERT INTO transactions (transaction_id, order_id, user_id, amount, user_data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [transactionId, orderId, userId, numericAmount, JSON.stringify(userData)]);

    const transaction = result.rows[0];
    const processingDuration = Date.now() - processingStart;

    logger.info('Payment processed successfully', {
      orderId,
      amount: numericAmount,
      userId,
      userName: userData?.name,
      transactionId,
      processingTime: `${processingDuration}ms`,
      route: '/pay'
    });

    res.json({
      status: 'paid',
      orderId,
      amount: numericAmount,
      transactionId,
      processedAt: transaction.created_at,
      user: userData
    });

  } catch (error) {
    logger.logError(error, {
      route: '/pay',
      orderId: req.body.orderId,
      amount: req.body.amount,
      userId: req.body.userId,
      errorType: 'payment_processing_error'
    });

    res.status(500).json({
      error: 'Payment processing failed',
      orderId: req.body.orderId,
      amount: req.body.amount
    });
  }
});

// Process refund
app.post('/refund', async (req, res) => {
  try {
    const { transactionId, amount, reason } = req.body;

    if (!transactionId || !amount) {
      logger.warn('Refund request missing required fields', {
        route: '/refund',
        transactionId: transactionId || 'missing',
        amount: amount || 'missing',
        requestBody: req.body
      });
      return res.status(400).json({
        error: 'Missing required fields: transactionId and amount are required'
      });
    }

    const refundAmount = parseFloat(amount);
    logger.info('Processing refund', {
      transactionId,
      amount: refundAmount,
      reason: reason || 'order_cancellation',
      route: '/refund'
    });

    // Find original transaction
    const transactionResult = await pool.query(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [transactionId]
    );

    if (transactionResult.rows.length === 0) {
      logger.warn('Transaction not found for refund', {
        transactionId
      });
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const originalTransaction = transactionResult.rows[0];

    if (refundAmount > originalTransaction.amount) {
      logger.warn('Refund amount exceeds original transaction', {
        transactionId,
        originalAmount: originalTransaction.amount,
        refundAmount
      });
      return res.status(400).json({
        error: 'Refund amount cannot exceed original transaction amount'
      });
    }

    // Create refund in database
    const refundId = `refund_${Date.now()}_${transactionId}`;
    const refundResult = await pool.query(`
      INSERT INTO refunds (refund_id, original_transaction_id, amount, reason)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [refundId, transactionId, refundAmount, reason || 'order_cancellation']);

    logger.info('Refund processed successfully', {
      refundId,
      transactionId,
      amount: refundAmount,
      reason: refundResult.rows[0].reason
    });

    res.json(refundResult.rows[0]);

  } catch (error) {
    logger.logError(error, {
      route: '/refund',
      transactionId: req.body.transactionId,
      amount: req.body.amount,
      errorType: 'refund_processing_error'
    });

    res.status(500).json({ error: 'Refund processing failed' });
  }
});

// Get payment history
app.get('/payments', async (req, res) => {
  try {
    const { orderId, userId, status, limit = 20, offset = 0 } = req.query;
    
    logger.info('Retrieving payment history', {
      route: '/payments',
      filters: { orderId, userId, status, limit, offset }
    });

    let query = 'SELECT * FROM transactions';
    let params = [];
    let conditions = [];

    if (orderId) {
      conditions.push(`order_id = $${params.length + 1}`);
      params.push(orderId);
    }

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
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM transactions';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit and offset

    logger.info('Payment history retrieved', {
      totalTransactions: parseInt(countResult.rows[0].count),
      filteredTransactions: result.rows.length
    });

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].count),
      filtered: result.rows.length
    });
  } catch (error) {
    logger.logError(error, {
      route: '/payments',
      errorType: 'payment_history_retrieval_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get refund history
app.get('/refunds', async (req, res) => {
  try {
    const { transactionId, limit = 20, offset = 0 } = req.query;

    logger.info('Retrieving refund history', {
      route: '/refunds',
      filters: { transactionId, limit, offset }
    });

    let query = 'SELECT * FROM refunds';
    let params = [];
    let conditions = [];

    if (transactionId) {
      conditions.push(`original_transaction_id = $${params.length + 1}`);
      params.push(transactionId);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM refunds';
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await pool.query(countQuery, params.slice(0, -2)); // Remove limit and offset

    logger.info('Refund history retrieved', {
      totalRefunds: parseInt(countResult.rows[0].count),
      filteredRefunds: result.rows.length
    });

    res.json({
      refunds: result.rows,
      total: parseInt(countResult.rows[0].count),
      filtered: result.rows.length
    });
  } catch (error) {
    logger.logError(error, {
      route: '/refunds',
      errorType: 'refund_history_retrieval_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get transaction status
app.get('/transactions/:id/status', async (req, res) => {
  try {
    const { id: transactionId } = req.params;

    logger.info('Checking transaction status', {
      transactionId,
      route: '/transactions/:id/status'
    });

    const transactionResult = await pool.query(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [transactionId]
    );

    if (transactionResult.rows.length === 0) {
      logger.warn('Transaction not found for status check', {
        transactionId
      });
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Get related refunds
    const refundsResult = await pool.query(
      'SELECT * FROM refunds WHERE original_transaction_id = $1',
      [transactionId]
    );

    const totalRefunded = refundsResult.rows.reduce((sum, refund) => 
      sum + parseFloat(refund.amount), 0
    );

    const transaction = transactionResult.rows[0];

    logger.info('Transaction status retrieved', {
      transactionId,
      status: transaction.status,
      totalRefunded
    });

    res.json({
      transaction,
      refunds: refundsResult.rows,
      totalRefunded,
      netAmount: parseFloat(transaction.amount) - totalRefunded
    });
  } catch (error) {
    logger.logError(error, {
      route: '/transactions/:id/status',
      transactionId: req.params.id,
      errorType: 'transaction_status_retrieval_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payment analytics
app.get('/analytics/payments', async (req, res) => {
  try {
    logger.info('Generating payment analytics', {
      route: '/analytics/payments'
    });

    const totalTransactionsResult = await pool.query('SELECT COUNT(*) FROM transactions');
    const totalRefundsResult = await pool.query('SELECT COUNT(*) FROM refunds');
    const revenueResult = await pool.query('SELECT SUM(amount) as total_revenue FROM transactions');
    const refundAmountResult = await pool.query('SELECT SUM(amount) as total_refunds FROM refunds');
    const avgResult = await pool.query('SELECT AVG(amount) as avg_transaction FROM transactions');

    const totalRevenue = parseFloat(revenueResult.rows[0].total_revenue) || 0;
    const totalRefundAmount = parseFloat(refundAmountResult.rows[0].total_refunds) || 0;
    const netRevenue = totalRevenue - totalRefundAmount;

    // Get user demographics for payment analytics
    const userIdsResult = await pool.query(
      'SELECT DISTINCT user_id FROM transactions WHERE user_id IS NOT NULL'
    );
    
    const userPromises = userIdsResult.rows.map(row =>
      axios.get(`http://user-service:3001/users/${row.user_id}/profile`, {
        timeout: 3000
      }).catch(err => {
        logger.warn('Failed to fetch user profile for payment analytics', {
          userId: row.user_id,
          error: err.message
        });
        return { data: { demographics: 'unknown' } };
      })
    );

    const userProfiles = await Promise.all(userPromises);

    const analytics = {
      totalTransactions: parseInt(totalTransactionsResult.rows[0].count),
      totalRefunds: parseInt(totalRefundsResult.rows[0].count),
      totalRevenue,
      totalRefundAmount,
      netRevenue,
      averageTransactionValue: parseFloat(avgResult.rows[0].avg_transaction) || 0,
      successRate: 0.95, // Based on 5% failure rate
      userDemographics: userProfiles.map(p => p.data.demographics || 'unknown'),
      generatedAt: new Date().toISOString()
    };

    logger.info('Payment analytics generated successfully', {
      totalTransactions: analytics.totalTransactions,
      totalRevenue: analytics.totalRevenue,
      netRevenue: analytics.netRevenue
    });

    res.json(analytics);
  } catch (error) {
    logger.logError(error, {
      route: '/analytics/payments',
      errorType: 'analytics_generation_error'
    });
    res.status(500).json({ error: 'Failed to generate payment analytics' });
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

app.post('/webhooks/user-activity', async (req, res) => {
  try {
    const { userId, action, sessionId, timestamp, ipAddress } = req.body;

    console.log(`Received user activity webhook: 
      userId: ${userId}, 
      action: ${action}, 
      sessionId: ${sessionId}, 
      timestamp: ${timestamp}, 
      ipAddress: ${ipAddress}`
    );

    // Example: store in DB or trigger fraud detection
    // await db.query('INSERT INTO user_activity_log (...) VALUES (...)', [...]);

    res.status(200).json({ message: 'Webhook received successfully' });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Health check with dependency checks
const services = {
  userService: 'http://user-service:3001/ready',
  orderService: 'http://order-service:3002/ready'
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
      acc[key] = results[i].status === "fulfilled" ? "ok" : "down";
      return acc;
    }, {});

    // Get transaction and refund counts from database
    const transactionCountResult = await pool.query('SELECT COUNT(*) FROM transactions');
    const refundCountResult = await pool.query('SELECT COUNT(*) FROM refunds');

    res.status(200).json({
      status: Object.values(statusReport).every(s => s === 'ok') ? 'ok' : 'partial',
      service: 'payment-service',
      database: 'ok',
      status_results: safeResults,
      services: statusReport,
      deps: statusReport,
      transactionsCount: parseInt(transactionCountResult.rows[0].count),
      refundsCount: parseInt(refundCountResult.rows[0].count)
    });

  } catch (error) {
    logger.logError(error, {
      endpoint: '/health',
      errorType: 'health_check_error'
    });
    res.status(500).json({ 
      status: 'error', 
      service: 'payment-service', 
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
  logger.info('Payment service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid,
    service: 'payment-service'
  });
  initDB().catch(err => {
    logger.logError(err, { context: 'Database initialization failed' });
    process.exit(1);
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

    pool.end();
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
  logger.logError(error, {
    context: 'Uncaught Exception',
    service: 'payment-service'
  });
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