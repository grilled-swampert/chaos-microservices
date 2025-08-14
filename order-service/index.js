const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

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
  const pool = new Pool();
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected');
      return pool;
    } catch (err) {
      console.log('DB connection failed, retrying in 5s...');
      await new Promise(res => setTimeout(res, 5000));
    }
  }
  throw new Error('Could not connect to DB');
}

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Create new order
app.post('/orders', async (req, res) => {
  try {
    const { userId, product, amount } = req.body;

    // Validate required fields
    if (!userId || !product || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: userId, product, and amount are required'
      });
    }

    // Get user data from user service
    const userResponse = await axios.get(`http://user-service:3001/users/${userId}`, {
      timeout: 5000
    });

    // Create order
    const result = await pool.query(`
      INSERT INTO orders (user_id, user_data, product, amount)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [userId, JSON.stringify(userResponse.data), product, parseFloat(amount)]);

    console.log(`Order created: ID ${result.rows[0].id} for user ${userId}`);
    res.status(201).json(result.rows[0]);

  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({ error: `User with ID ${req.body.userId} not found` });
    }
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'User service unavailable' });
    }
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get all orders with filtering
app.get('/orders', async (req, res) => {
  try {
    const { userId, status, limit = 20, offset = 0 } = req.query;
    
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

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].count),
      filtered: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order by ID
app.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Process payment for order
app.post('/orders/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // Get order
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    
    if (order.status === 'paid') {
      return res.status(400).json({ error: 'Order already paid' });
    }

    // Process payment through payment service
    const paymentResponse = await axios.post('http://payment-service:3003/pay', {
      orderId: order.id,
      amount: order.amount,
      userId: order.user_id
    }, { timeout: 10000 });

    // Update order status
    const updateResult = await pool.query(`
      UPDATE orders 
      SET status = 'paid', 
          payment_details = $2, 
          paid_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, JSON.stringify(paymentResponse.data)]);

    console.log(`Order ${id} payment processed successfully`);
    
    res.json({
      order: updateResult.rows[0],
      payment: paymentResponse.data
    });

  } catch (error) {
    if (error.response?.status === 402) {
      return res.status(402).json({ error: 'Payment failed: ' + error.response.data.error });
    }
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Payment service unavailable' });
    }
    console.error('Error processing payment:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Cancel order
app.delete('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }

    // Get order
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
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
        console.log(`Refund processed for cancelled order ${id}`);
      } catch (error) {
        console.error('Failed to process refund:', error);
      }
    }

    // Delete order
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    
    console.log(`Order ${id} cancelled successfully`);
    res.json({ message: 'Order cancelled successfully', cancelledOrder: order });

  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order analytics
app.get('/analytics/orders', async (req, res) => {
  try {
    const totalOrdersResult = await pool.query('SELECT COUNT(*) FROM orders');
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as count, SUM(amount) as revenue
      FROM orders 
      GROUP BY status
    `);
    const avgResult = await pool.query('SELECT AVG(amount) as avg_order_value FROM orders');

    const analytics = {
      totalOrders: parseInt(totalOrdersResult.rows[0].count),
      ordersByStatus: {},
      totalRevenue: 0,
      averageOrderValue: parseFloat(avgResult.rows[0].avg_order_value) || 0,
      generatedAt: new Date().toISOString()
    };

    statusResult.rows.forEach(row => {
      analytics.ordersByStatus[row.status] = parseInt(row.count);
      if (row.status === 'paid') {
        analytics.totalRevenue = parseFloat(row.revenue) || 0;
      }
    });

    res.json(analytics);
  } catch (error) {
    console.error('Error generating analytics:', error);
    res.status(500).json({ error: 'Failed to generate analytics' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'order-service' });
  } catch (error) {
    res.status(500).json({ status: 'error', service: 'order-service', error: 'Database connection failed' });
  }
});

app.get('/ready', (req, res) => res.sendStatus(200));

// Start server
const server = app.listen(port, () => {
  console.log(`Order service running on port ${port}`);
  initDB();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down order service...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});