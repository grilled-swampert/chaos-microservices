const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
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

    // Insert sample users if none exist
    const { rowCount } = await pool.query('SELECT COUNT(*) FROM users');
    if (rowCount === 0) {
      await pool.query(`
        INSERT INTO users (name, email, phone, address, demographics) VALUES
        ('Alice', 'alice@example.com', '+91-9876543210', 
         '{"street": "123 MG Road", "city": "Mumbai", "state": "Maharashtra", "pincode": "400001"}',
         '{"age": 28, "gender": "female", "occupation": "Software Engineer", "income_bracket": "high"}'),
        ('Bob', 'bob@example.com', '+91-9876543211',
         '{"street": "456 Brigade Road", "city": "Bangalore", "state": "Karnataka", "pincode": "560025"}',
         '{"age": 34, "gender": "male", "occupation": "Marketing Manager", "income_bracket": "medium"}'),
        ('Priya', 'priya@example.com', '+91-9876543212',
         '{"street": "789 Connaught Place", "city": "Delhi", "state": "Delhi", "pincode": "110001"}',
         '{"age": 25, "gender": "female", "occupation": "Designer", "income_bracket": "medium"}')
      `);
    }
    console.log('User service database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
};

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Get user by ID
app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'profile_viewed', { route: '/users/:id' }]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full user profile
app.get('/users/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'full_profile_viewed', { route: '/users/:id/profile' }]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
app.put('/users/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, address, demographics } = req.body;

    const result = await pool.query(`
      UPDATE users 
      SET name = COALESCE($2, name),
          email = COALESCE($3, email),
          phone = COALESCE($4, phone),
          address = COALESCE($5, address),
          demographics = COALESCE($6, demographics),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, name, email, phone, address, demographics]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log user activity
    await pool.query(
      'INSERT INTO user_activity (user_id, action, details) VALUES ($1, $2, $3)',
      [id, 'profile_updated', { updated_fields: Object.keys(req.body) }]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user orders (from order service)
app.get('/users/:id/orders', async (req, res) => {
  try {
    const { id } = req.params;
    
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
      [id, 'orders_viewed', { order_count: ordersResponse.data.filtered }]
    );

    res.json({
      user: userResult.rows[0],
      orders: ordersResponse.data
    });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Order service unavailable' });
    }
    console.error('Error fetching user orders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user payments (from payment service)
app.get('/users/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    
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
      [id, 'payments_viewed', { payment_count: paymentsResponse.data.filtered }]
    );

    res.json({
      user: userResult.rows[0],
      payments: paymentsResponse.data
    });
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Payment service unavailable' });
    }
    console.error('Error fetching user payments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
app.get('/users', async (req, res) => {
  try {
    const { limit = 10, offset = 0, search } = req.query;
    
    let query = 'SELECT id, name, email, created_at FROM users';
    let params = [];
    let whereClause = '';

    if (search) {
      whereClause = ' WHERE name ILIKE $1 OR email ILIKE $1';
      params.push(`%${search}%`);
    }

    query += whereClause + ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM users' + whereClause, search ? [`%${search}%`] : []);

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      returned: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'user-service' });
});

app.get('/ready', (req, res) => res.sendStatus(200));

// Start server
const server = app.listen(port, () => {
  console.log(`User service running on port ${port}`);
  initDB();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down user service...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});