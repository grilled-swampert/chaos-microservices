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
const CircuitBreaker = require("opossum");

const provider = new NodeTracerProvider();
const exporter = new JaegerExporter({
  endpoint: "http://jaeger-collector.observability.svc.cluster.local:14268/api/traces",
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  })
);

// Configure breaker
const breaker = new CircuitBreaker(callPayment, {
  timeout: 3000, // fail if it takes longer than 3s
  errorThresholdPercentage: 50, // open if >50% fail
  resetTimeout: 10000, // try again after 10s
});

// Fallback if breaker is open
breaker.fallback(() => "User service unavailable. Please try later.");

const port = process.env.PORT || 3001;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-service',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'ecommerce',
  user: 'postgres',
  password: process.env.DB_PASSWORD || 'password',
});

// Initialize database tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(20),
        address JSONB,
        demographics JSONB,
        preferences JSONB DEFAULT '{"currency": "INR", "language": "en", "notifications": true}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        last_login_at TIMESTAMP,
        last_accessed_at TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        details JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(100) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        device_info TEXT,
        ip_address INET,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        last_active_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert sample users if none exist
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO users (name, email, phone, address, demographics, preferences, last_login_at) VALUES
        ('Alice', 'alice@example.com', '+91-9876543210', 
         '{"street": "123 MG Road", "city": "Mumbai", "state": "Maharashtra", "pincode": "400001", "country": "India"}',
         '{"age": 28, "gender": "female", "occupation": "Software Engineer", "income_bracket": "high"}',
         '{"currency": "INR", "language": "en", "notifications": true}',
         '2025-08-10T14:22:00Z'),
        ('Bob', 'bob@example.com', '+91-9876543211',
         '{"street": "456 Brigade Road", "city": "Bangalore", "state": "Karnataka", "pincode": "560025", "country": "India"}',
         '{"age": 34, "gender": "male", "occupation": "Marketing Manager", "income_bracket": "medium"}',
         '{"currency": "INR", "language": "en", "notifications": false}',
         '2025-08-11T08:45:00Z'),
        ('Priya', 'priya@example.com', '+91-9876543212',
         '{"street": "789 Connaught Place", "city": "Delhi", "state": "Delhi", "pincode": "110001", "country": "India"}',
         '{"age": 25, "gender": "female", "occupation": "Designer", "income_bracket": "medium"}',
         '{"currency": "INR", "language": "hi", "notifications": true}',
         '2025-08-09T20:10:00Z')
      `);
    }
    logger.info('User service database initialized');
  } catch (error) {
    logger.logError(error, { context: 'Database initialization error' });
  }
};

// Enhanced logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  // Log the incoming request
  logger.info('Incoming request', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent'),
  });

  // Override res.end to log response details
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - startTime;
    logger.logRequest(req, res, duration);
    originalEnd.apply(this, args);
  };

  next();
});

// Get user by ID (basic info)
app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('User lookup requested', {
      userId: id,
      route: '/users/:id',
    });

    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1', 
      [id]
    );
    
    if (result.rows.length === 0) {
      logger.warn('User not found', {
        userId: id,
      });
      return res.status(404).json({ error: 'User not found' });
    }

    // Update last accessed time
    await pool.query(
      'UPDATE users SET last_accessed_at = NOW() WHERE id = $1',
      [id]
    );

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'profile_viewed', { route: '/users/:id' }]
    );

    logger.info('User found successfully', {
      userId: id,
      userName: result.rows[0].name,
    });

    res.json(result.rows[0]);
  } catch (error) {
    logger.logError(error, { 
      route: '/users/:id',
      userId: req.params.id,
      errorType: 'user_fetch_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full user profile
app.get('/users/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('User profile requested', {
      userId: id,
      route: '/users/:id/profile',
    });

    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      logger.warn('User not found for profile request', {
        userId: id,
      });
      return res.status(404).json({ error: 'User not found' });
    }

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'full_profile_viewed', { route: '/users/:id/profile' }]
    );

    logger.info('User profile retrieved successfully', {
      userId: id,
      userName: result.rows[0].name,
    });

    res.json(result.rows[0]);
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/profile',
      userId: req.params.id,
      errorType: 'profile_fetch_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
app.put('/users/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, address, demographics, preferences } = req.body;

    logger.info('User profile update requested', {
      userId: id,
      route: '/users/:id/profile',
      updateFields: Object.keys(req.body),
    });

    const result = await pool.query(`
      UPDATE users 
      SET name = COALESCE($2, name),
          email = COALESCE($3, email),
          phone = COALESCE($4, phone),
          address = COALESCE($5, address),
          demographics = COALESCE($6, demographics),
          preferences = COALESCE($7, preferences),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, name, email, phone, address, demographics, preferences]);

    if (result.rows.length === 0) {
      logger.warn('User not found for profile update', {
        userId: id,
      });
      return res.status(404).json({ error: 'User not found' });
    }

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'profile_updated', { 
        updated_fields: Object.keys(req.body),
        changes: req.body
      }]
    );

    // Notify other services about profile update if needed
    try {
      await axios.post(
        'http://order-service:3002/webhooks/user-updated',
        {
          userId: id,
          changes: req.body,
          timestamp: new Date().toISOString(),
        },
        { timeout: 3000 }
      );
    } catch (err) {
      logger.warn('Failed to notify order service about profile update', {
        userId: id,
        error: err.message,
      });
    }

    logger.info('User profile updated successfully', {
      userId: id,
      userName: result.rows[0].name,
      updatedFields: Object.keys(req.body),
    });

    res.json(result.rows[0]);
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/profile',
      userId: req.params.id,
      errorType: 'profile_update_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user activity history
app.get('/users/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, type } = req.query;

    logger.info('User activity requested', {
      userId: id,
      route: '/users/:id/activity',
      filters: { limit, type },
    });

    // Check if user exists
    const userResult = await pool.query('SELECT id, name FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    let query = 'SELECT * FROM user_activity WHERE user_id = $1';
    let params = [id];

    if (type) {
      query += ' AND action = $2';
      params.push(type);
    }

    query += ' ORDER BY created_at DESC';

    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        query += ` LIMIT $${params.length + 1}`;
        params.push(limitNum);
      }
    }

    const result = await pool.query(query, params);

    logger.info('User activity retrieved', {
      userId: id,
      totalActivities: result.rows.length,
    });

    res.json({
      userId: parseInt(id),
      activities: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/activity',
      userId: req.params.id,
      errorType: 'activity_fetch_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create user session (login)
app.post('/users/:id/sessions', async (req, res) => {
  try {
    const { id } = req.params;
    const { deviceInfo, ipAddress } = req.body;

    logger.info('User session creation requested', {
      userId: id,
      route: '/users/:id/sessions',
    });

    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sessionId = `session_${Date.now()}_${id}`;
    const sessionIpAddress = ipAddress || req.ip || 'unknown';

    // Create session
    const sessionResult = await pool.query(`
      INSERT INTO user_sessions (session_id, user_id, device_info, ip_address, created_at, last_active_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `, [sessionId, id, deviceInfo || 'unknown', sessionIpAddress]);

    // Update user's last login
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'user_login', {
        sessionId,
        deviceInfo: deviceInfo || 'unknown',
        ipAddress: sessionIpAddress,
      }]
    );

    // Notify payment service about user activity for fraud detection
    try {
      await axios.post(
        'http://payment-service:3003/webhooks/user-activity',
        {
          userId: id,
          action: 'login',
          sessionId,
          timestamp: new Date().toISOString(),
          ipAddress: sessionIpAddress,
        },
        { timeout: 3000 }
      );
    } catch (err) {
      logger.warn('Failed to notify payment service about user login', {
        userId: id,
        sessionId,
        error: err.message,
      });
    }

    logger.info('User session created successfully', {
      userId: id,
      sessionId,
      userName: userResult.rows[0].name,
    });

    res.status(201).json(sessionResult.rows[0]);
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/sessions',
      userId: req.params.id,
      errorType: 'session_creation_error'
    });
    res.status(500).json({ error: 'Failed to create user session' });
  }
});

// Get user orders (from order service)
app.get('/users/:id/orders', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('User orders requested', {
      userId: id,
      route: '/users/:id/orders',
    });
    
    // Check if user exists
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get orders from order service
    const ordersResponse = await axios.get(`http://order-service:3002/orders?userId=${id}`, {
      timeout: 5000
    });

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'orders_viewed', { 
        route: '/users/:id/orders',
        order_count: ordersResponse.data.filtered 
      }]
    );

    logger.info('User orders retrieved successfully', {
      userId: id,
      orderCount: ordersResponse.data.filtered,
    });

    res.json({
      user: userResult.rows[0],
      orders: ordersResponse.data
    });
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/orders',
      userId: req.params.id,
      errorType: 'order_fetch_error'
    });

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Order service unavailable' });
    }
    res.status(500).json({ error: 'Failed to fetch user orders' });
  }
});

// Get user payments (from payment service)
app.get('/users/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info('User payments requested', {
      userId: id,
      route: '/users/:id/payments',
    });
    
    // Check if user exists
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get payments from payment service
    const paymentsResponse = await axios.get(`http://payment-service:3003/payments?userId=${id}`, {
      timeout: 5000
    });

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'payments_viewed', { 
        route: '/users/:id/payments',
        payment_count: paymentsResponse.data.filtered 
      }]
    );

    logger.info('User payments retrieved successfully', {
      userId: id,
      paymentCount: paymentsResponse.data.filtered,
    });

    res.json({
      user: userResult.rows[0],
      payments: paymentsResponse.data
    });
  } catch (error) {
    logger.logError(error, {
      route: '/users/:id/payments',
      userId: req.params.id,
      errorType: 'payment_fetch_error'
    });

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ error: 'Payment service unavailable' });
    }
    res.status(500).json({ error: 'Failed to fetch user payments' });
  }
});

// Get all users (with pagination and search)
app.get('/users', async (req, res) => {
  try {
    const { limit = 10, offset = 0, search } = req.query;

    logger.info('Users list requested', {
      route: '/users',
      filters: { limit, offset, search },
    });
    
    let query = 'SELECT id, name, email, created_at, last_login_at FROM users';
    let countQuery = 'SELECT COUNT(*) FROM users';
    let params = [];
    let whereClause = '';

    if (search) {
      whereClause = ' WHERE name ILIKE $1 OR email ILIKE $1';
      params.push(`%${search}%`);
    }

    query += whereClause + ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    countQuery += whereClause;
    params.push(limit, offset);

    const [result, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, search ? [`%${search}%`] : [])
    ]);

    const totalUsers = parseInt(countResult.rows[0].count);

    logger.info('Users list retrieved successfully', {
      totalUsers,
      returnedUsers: result.rows.length,
    });

    res.json({
      users: result.rows,
      total: totalUsers,
      returned: result.rows.length
    });
  } catch (error) {
    logger.logError(error, {
      route: '/users',
      errorType: 'users_list_error'
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User analytics endpoint
app.get('/analytics/users', async (req, res) => {
  try {
    logger.info('Generating user analytics', {
      route: '/analytics/users',
    });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get user statistics
    const [usersResult, activityResult, recentActivityResult] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN demographics->>'gender' = 'male' THEN 1 END) as male_users,
          COUNT(CASE WHEN demographics->>'gender' = 'female' THEN 1 END) as female_users,
          COUNT(CASE WHEN demographics->>'income_bracket' = 'high' THEN 1 END) as high_income,
          COUNT(CASE WHEN demographics->>'income_bracket' = 'medium' THEN 1 END) as medium_income,
          COUNT(CASE WHEN demographics->>'income_bracket' = 'low' THEN 1 END) as low_income
        FROM users
      `),
      pool.query('SELECT COUNT(*) as total_activities FROM user_activity'),
      pool.query('SELECT user_id, action, COUNT(*) as count FROM user_activity WHERE created_at > $1 GROUP BY user_id, action', [thirtyDaysAgo])
    ]);

    const activeUsers = [...new Set(recentActivityResult.rows.map(r => r.user_id))].length;

    // Get order analytics if available
    let orderAnalytics = {};
    try {
      const ordersResponse = await axios.get(
        'http://order-service:3002/analytics/orders',
        { timeout: 5000 }
      );
      orderAnalytics = ordersResponse.data;
    } catch (err) {
      logger.warn('Failed to get order analytics for user analytics', {
        error: err.message,
      });
    }

    const analytics = {
      totalUsers: parseInt(usersResult.rows[0].total_users),
      activeUsers,
      usersByDemographics: {
        genderDistribution: {
          male: parseInt(usersResult.rows[0].male_users),
          female: parseInt(usersResult.rows[0].female_users)
        },
        incomeDistribution: {
          high: parseInt(usersResult.rows[0].high_income),
          medium: parseInt(usersResult.rows[0].medium_income),
          low: parseInt(usersResult.rows[0].low_income)
        }
      },
      activitySummary: {
        totalActivities: parseInt(activityResult.rows[0].total_activities),
        recentActivities: recentActivityResult.rows.length,
        activitiesByType: recentActivityResult.rows.reduce((acc, row) => {
          acc[row.action] = (acc[row.action] || 0) + parseInt(row.count);
          return acc;
        }, {})
      },
      orderInsights: orderAnalytics,
      generatedAt: new Date().toISOString(),
    };

    logger.info('User analytics generated successfully', {
      totalUsers: analytics.totalUsers,
      activeUsers: analytics.activeUsers,
    });

    res.json(analytics);
  } catch (error) {
    logger.logError(error, {
      route: '/analytics/users',
      errorType: 'analytics_generation_error'
    });
    res.status(500).json({ error: 'Failed to generate user analytics' });
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

// Enhanced health check
const services = {
  orderService: 'http://order-service:3002/ready',
  paymentService: 'http://payment-service:3003/ready',
};

app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');
    
    // Check dependent services
    const results = await Promise.allSettled(
      Object.entries(services).map(([key, url]) =>
        axios.get(url, { timeout: 3000 })
          .then(() => ({ service: key, status: 'ok' }))
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
      acc[key] = results[i].status === 'fulfilled' ? 'ok' : 'down';
      return acc;
    }, {});

    // Get counts from database
    const [usersCount, activitiesCount, sessionsCount] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM user_activity'),
      pool.query('SELECT COUNT(*) FROM user_sessions')
    ]);

    res.status(200).json({
      status: Object.values(statusReport).every(s => s === 'ok') ? 'ok' : 'partial',
      database: 'ok',
      services: safeResults,
      deps: statusReport,
      usersCount: parseInt(usersCount.rows[0].count),
      activitiesCount: parseInt(activitiesCount.rows[0].count),
      sessionsCount: parseInt(sessionsCount.rows[0].count),
    });
  } catch (error) {
    logger.logError(error, { context: 'Health check failed' });
    res.status(500).json({
      status: 'error',
      database: 'down',
      error: error.message
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
    userAgent: req.get('User-Agent'),
  });

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.id || 'unknown',
  });
});

// Handle 404 routes
app.use((req, res) => {
  logger.warn('Route not found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  });

  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl,
  });
});

// Start server
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('User service started successfully', {
    port,
    environment: process.env.NODE_ENV || 'development',
    processId: process.pid,
  });
  initDB();
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  server.close((err) => {
    if (err) {
      logger.logError(err, { context: 'Graceful shutdown failed' });
      process.exit(1);
    }

    pool.end(() => {
      logger.info('Database connection closed');
      logger.info('Server closed successfully');
      process.exit(0);
    });
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
    promise: promise.toString(),
  });
});