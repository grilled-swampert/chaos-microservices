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
  { 
    id: 1, 
    name: 'Alice',
    email: 'alice@example.com',
    phone: '+91-9876543210',
    address: {
      street: '123 MG Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      country: 'India'
    },
    demographics: {
      age: 28,
      gender: 'female',
      occupation: 'Software Engineer',
      income_bracket: 'high'
    },
    preferences: {
      currency: 'INR',
      language: 'en',
      notifications: true
    },
    createdAt: '2023-01-15T10:30:00Z',
    lastLoginAt: '2025-08-10T14:22:00Z'
  },
  { 
    id: 2, 
    name: 'Bob',
    email: 'bob@example.com',
    phone: '+91-9876543211',
    address: {
      street: '456 Brigade Road',
      city: 'Bangalore',
      state: 'Karnataka', 
      pincode: '560025',
      country: 'India'
    },
    demographics: {
      age: 34,
      gender: 'male',
      occupation: 'Marketing Manager',
      income_bracket: 'medium'
    },
    preferences: {
      currency: 'INR',
      language: 'en',
      notifications: false
    },
    createdAt: '2023-03-22T09:15:00Z',
    lastLoginAt: '2025-08-11T08:45:00Z'
  },
  {
    id: 3,
    name: 'Priya',
    email: 'priya@example.com',
    phone: '+91-9876543212',
    address: {
      street: '789 Connaught Place',
      city: 'Delhi',
      state: 'Delhi',
      pincode: '110001',
      country: 'India'
    },
    demographics: {
      age: 25,
      gender: 'female',
      occupation: 'Designer',
      income_bracket: 'medium'
    },
    preferences: {
      currency: 'INR',
      language: 'hi',
      notifications: true
    },
    createdAt: '2023-06-10T16:20:00Z',
    lastLoginAt: '2025-08-09T20:10:00Z'
  }
];

let userActivity = [];
let userSessions = [];

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

  // Log user activity
  userActivity.push({
    userId: user.id,
    action: 'profile_viewed',
    timestamp: new Date().toISOString(),
    details: { route: '/users/:id' }
  });

  // Update last accessed
  user.lastAccessedAt = new Date().toISOString();

  logger.info('User found successfully', { 
    userId,
    userName: user.name
  });
  
  // Return basic user info (without sensitive details)
  res.send({
    id: user.id,
    name: user.name,
    email: user.email
  });
});

// NEW: Get full user profile with detailed information
app.get('/users/:id/profile', (req, res) => {
  const userId = parseInt(req.params.id);
  
  logger.info('User profile requested', {
    userId,
    route: '/users/:id/profile'
  });

  const user = users.find(u => u.id === userId);

  if (!user) {
    logger.warn('User not found for profile request', {
      userId,
      availableUserIds: users.map(u => u.id)
    });
    return res.status(404).send({ error: 'User not found' });
  }

  // Log user activity
  userActivity.push({
    userId: user.id,
    action: 'full_profile_viewed',
    timestamp: new Date().toISOString(),
    details: { route: '/users/:id/profile' }
  });

  logger.info('User profile retrieved successfully', {
    userId,
    userName: user.name
  });

  res.send(user);
});

// NEW: Update user profile
app.put('/users/:id/profile', async (req, res) => {
  const userId = parseInt(req.params.id);
  const updates = req.body;
  
  logger.info('User profile update requested', {
    userId,
    route: '/users/:id/profile',
    updateFields: Object.keys(updates)
  });

  const userIndex = users.findIndex(u => u.id === userId);

  if (userIndex === -1) {
    logger.warn('User not found for profile update', {
      userId
    });
    return res.status(404).send({ error: 'User not found' });
  }

  try {
    // Update user with provided fields
    const user = users[userIndex];
    const originalData = { ...user };

    if (updates.name) user.name = updates.name;
    if (updates.email) user.email = updates.email;
    if (updates.phone) user.phone = updates.phone;
    if (updates.address) user.address = { ...user.address, ...updates.address };
    if (updates.demographics) user.demographics = { ...user.demographics, ...updates.demographics };
    if (updates.preferences) user.preferences = { ...user.preferences, ...updates.preferences };

    user.updatedAt = new Date().toISOString();

    // Log user activity
    userActivity.push({
      userId: user.id,
      action: 'profile_updated',
      timestamp: new Date().toISOString(),
      details: { 
        route: '/users/:id/profile',
        updatedFields: Object.keys(updates),
        changes: updates
      }
    });

    // Notify other services about profile update if needed
    try {
      await axios.post('http://order-service:3002/webhooks/user-updated', {
        userId: user.id,
        changes: updates,
        timestamp: new Date().toISOString()
      }, { timeout: 3000 });
    } catch (err) {
      logger.warn('Failed to notify order service about profile update', {
        userId,
        error: err.message
      });
    }

    logger.info('User profile updated successfully', {
      userId,
      userName: user.name,
      updatedFields: Object.keys(updates)
    });

    res.send(user);

  } catch (err) {
    logger.logError(err, {
      route: '/users/:id/profile',
      userId,
      errorType: 'profile_update_error'
    });

    res.status(500).send({
      error: 'Failed to update user profile'
    });
  }
});

// NEW: Get user activity history
app.get('/users/:id/activity', (req, res) => {
  const userId = parseInt(req.params.id);
  const { limit, type } = req.query;
  
  logger.info('User activity requested', {
    userId,
    route: '/users/:id/activity',
    filters: { limit, type }
  });

  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).send({ error: 'User not found' });
  }

  let activities = userActivity.filter(a => a.userId === userId);

  if (type) {
    activities = activities.filter(a => a.action === type);
  }

  if (limit) {
    const limitNum = parseInt(limit);
    if (!isNaN(limitNum) && limitNum > 0) {
      activities = activities.slice(-limitNum); // Get most recent activities
    }
  }

  logger.info('User activity retrieved', {
    userId,
    totalActivities: activities.length
  });

  res.send({
    userId,
    activities: activities.reverse(), // Most recent first
    total: activities.length
  });
});

// NEW: Create user session (login)
app.post('/users/:id/sessions', async (req, res) => {
  const userId = parseInt(req.params.id);
  const { deviceInfo, ipAddress } = req.body;
  
  logger.info('User session creation requested', {
    userId,
    route: '/users/:id/sessions'
  });

  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).send({ error: 'User not found' });
  }

  try {
    const sessionId = `session_${Date.now()}_${userId}`;
    const session = {
      sessionId,
      userId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      deviceInfo: deviceInfo || 'unknown',
      ipAddress: ipAddress || req.ip || 'unknown',
      status: 'active'
    };

    userSessions.push(session);

    // Update user's last login
    user.lastLoginAt = new Date().toISOString();

    // Log user activity
    userActivity.push({
      userId,
      action: 'user_login',
      timestamp: new Date().toISOString(),
      details: { 
        sessionId,
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress
      }
    });

    // Notify payment service about user activity for fraud detection
    try {
      await axios.post('http://payment-service:3003/webhooks/user-activity', {
        userId,
        action: 'login',
        sessionId,
        timestamp: new Date().toISOString(),
        ipAddress: session.ipAddress
      }, { timeout: 3000 });
    } catch (err) {
      logger.warn('Failed to notify payment service about user login', {
        userId,
        sessionId,
        error: err.message
      });
    }

    logger.info('User session created successfully', {
      userId,
      sessionId,
      userName: user.name
    });

    res.status(201).send(session);

  } catch (err) {
    logger.logError(err, {
      route: '/users/:id/sessions',
      userId,
      errorType: 'session_creation_error'
    });

    res.status(500).send({
      error: 'Failed to create user session'
    });
  }
});

// NEW: Get user's order history from order service
app.get('/users/:id/orders', async (req, res) => {
  const userId = parseInt(req.params.id);
  
  logger.info('User orders requested', {
    userId,
    route: '/users/:id/orders'
  });

  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).send({ error: 'User not found' });
  }

  try {
    const ordersResponse = await axios.get(`http://order-service:3002/orders?userId=${userId}`, {
      timeout: 5000
    });

    // Log user activity
    userActivity.push({
      userId,
      action: 'orders_viewed',
      timestamp: new Date().toISOString(),
      details: { 
        route: '/users/:id/orders',
        orderCount: ordersResponse.data.filtered
      }
    });

    logger.info('User orders retrieved successfully', {
      userId,
      orderCount: ordersResponse.data.filtered
    });

    res.send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      orders: ordersResponse.data
    });

  } catch (err) {
    logger.logError(err, {
      route: '/users/:id/orders',
      userId,
      errorType: 'order_fetch_error'
    });

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(503).send({
        error: 'Order service unavailable'
      });
    }

    res.status(500).send({
      error: 'Failed to fetch user orders'
    });
  }
});

// NEW: Get user's payment history from payment service
app.get('/users/:id/payments', async (req, res) => {
  const userId = parseInt(req.params.id);
  
  logger.info('User payments requested', {
    userId,
    route: '/users/:id/payments'
  });

  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).send({ error: 'User not found' });
  }

  try {
    const paymentsResponse = await axios.get(`http://payment-service:3003/payments?userId=${userId}`, {
      timeout: 5000
    });

    // Log user activity
    userActivity.push({
      userId,
      action: 'payments_viewed',
      timestamp: new Date().toISOString(),
      details: { 
        route: '/users/:id/payments',
        paymentCount: paymentsResponse.data.filtered
      }
    });

    logger.info('User payments retrieved successfully', {
      userId,
      paymentCount: paymentsResponse.data.filtered
    });

    res.send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      payments: paymentsResponse.data
    });

  } catch (err) {
    logger.logError(err, {
      route: '/users/:id/payments',
      userId,
      errorType: 'payment_fetch_error'
    });

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(503).send({
        error: 'Payment service unavailable'
      });
    }

    res.status(500).send({
      error: 'Failed to fetch user payments'
    });
  }
});

// NEW: Get all users (with pagination)
app.get('/users', (req, res) => {
  const { limit, offset, search } = req.query;
  
  logger.info('Users list requested', {
    route: '/users',
    filters: { limit, offset, search }
  });

  let filteredUsers = [...users];

  if (search) {
    const searchTerm = search.toLowerCase();
    filteredUsers = filteredUsers.filter(user => 
      user.name.toLowerCase().includes(searchTerm) ||
      user.email.toLowerCase().includes(searchTerm)
    );
  }

  const totalUsers = filteredUsers.length;
  
  if (offset) {
    const offsetNum = parseInt(offset);
    if (!isNaN(offsetNum) && offsetNum >= 0) {
      filteredUsers = filteredUsers.slice(offsetNum);
    }
  }

  if (limit) {
    const limitNum = parseInt(limit);
    if (!isNaN(limitNum) && limitNum > 0) {
      filteredUsers = filteredUsers.slice(0, limitNum);
    }
  }

  // Return only basic user info
  const basicUsers = filteredUsers.map(user => ({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  }));

  logger.info('Users list retrieved successfully', {
    totalUsers,
    filteredUsers: basicUsers.length
  });

  res.send({
    users: basicUsers,
    total: users.length,
    filtered: totalUsers,
    returned: basicUsers.length
  });
});

// NEW: User analytics endpoint
app.get('/analytics/users', async (req, res) => {
  logger.info('Generating user analytics', {
    route: '/analytics/users'
  });

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const recentActivity = userActivity.filter(activity => 
      new Date(activity.timestamp) > thirtyDaysAgo
    );

    const activeUsers = [...new Set(recentActivity.map(a => a.userId))];
    
    // Get user orders for analytics
    let orderAnalytics = {};
    try {
      const ordersResponse = await axios.get('http://order-service:3002/analytics/orders', {
        timeout: 5000
      });
      orderAnalytics = ordersResponse.data;
    } catch (err) {
      logger.warn('Failed to get order analytics for user analytics', {
        error: err.message
      });
    }

    const analytics = {
      totalUsers: users.length,
      activeUsers: activeUsers.length,
      usersByDemographics: {
        ageGroups: users.reduce((acc, user) => {
          const age = user.demographics.age;
          const group = age < 25 ? '18-24' : age < 35 ? '25-34' : age < 45 ? '35-44' : '45+';
          acc[group] = (acc[group] || 0) + 1;
          return acc;
        }, {}),
        genderDistribution: users.reduce((acc, user) => {
          acc[user.demographics.gender] = (acc[user.demographics.gender] || 0) + 1;
          return acc;
        }, {}),
        incomeDistribution: users.reduce((acc, user) => {
          acc[user.demographics.income_bracket] = (acc[user.demographics.income_bracket] || 0) + 1;
          return acc;
        }, {})
      },
      activitySummary: {
        totalActivities: recentActivity.length,
        activitiesByType: recentActivity.reduce((acc, activity) => {
          acc[activity.action] = (acc[activity.action] || 0) + 1;
          return acc;
        }, {})
      },
      orderInsights: orderAnalytics,
      generatedAt: new Date().toISOString()
    };

    logger.info('User analytics generated successfully', {
      totalUsers: analytics.totalUsers,
      activeUsers: analytics.activeUsers
    });

    res.send(analytics);

  } catch (err) {
    logger.logError(err, {
      route: '/analytics/users',
      errorType: 'analytics_generation_error'
    });

    res.status(500).send({
      error: 'Failed to generate user analytics'
    });
  }
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
    
    // Check dependencies
    const checks = await Promise.allSettled([
      axios.get('http://127.0.0.1:58231/health', { timeout: 1000 }),
      axios.get('http://127.0.0.1:58179/health', { timeout: 1000 })
    ]);

    const orderServiceOk = checks[0].status === 'fulfilled';
    const paymentServiceOk = checks[1].status === 'fulfilled';
    const healthCheckDuration = Date.now() - healthCheckStart;
    
    logger.info('Health check completed', {
      endpoint: '/health',
      orderService: orderServiceOk ? 'ok' : 'down',
      paymentService: paymentServiceOk ? 'ok' : 'down',
      responseTime: `${healthCheckDuration}ms`,
      usersInMemory: users.length,
      activitiesInMemory: userActivity.length,
      sessionsInMemory: userSessions.length
    });
    
    const allServicesOk = orderServiceOk && paymentServiceOk;
    const status = allServicesOk ? 200 : 503;
    
    res.status(status).send({ 
      status: allServicesOk ? 'ok' : 'degraded',
      deps: { 
        orderService: orderServiceOk ? 'ok' : 'down',
        paymentService: paymentServiceOk ? 'ok' : 'down'
      },
      usersCount: users.length,
      activitiesCount: userActivity.length,
      sessionsCount: userSessions.length
    });
  } catch (error) {
    logger.warn('Health check failed - service degraded', {
      endpoint: '/health',
      error: error.message,
      errorCode: error.code
    });
    
    res.status(503).send({ 
      status: 'down',
      deps: { orderService: 'unknown', paymentService: 'unknown' },
      usersCount: users.length,
      activitiesCount: userActivity.length,
      sessionsCount: userSessions.length
    });
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