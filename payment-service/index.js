const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

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
const initDB = async () => {
  try {
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

    console.log('Payment service database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
};

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Process payment
app.post('/pay', async (req, res) => {
  try {
    const { orderId, amount, userId } = req.body;

    // Validate required fields
    if (!orderId || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: orderId and amount are required'
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount: must be a positive number'
      });
    }

    // Simulate random payment failures (5% failure rate)
    if (Math.random() < 0.05) {
      console.log(`Payment failed for order ${orderId}: insufficient funds`);
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
        const userResponse = await axios.get(`http://user-service:3001/users/${userId}`, {
          timeout: 3000
        });
        userData = userResponse.data;
      } catch (error) {
        console.warn(`Failed to get user info for payment: ${error.message}`);
      }
    }

    // Create transaction
    const transactionId = `txn_${Date.now()}_${orderId}`;
    const result = await pool.query(`
      INSERT INTO transactions (transaction_id, order_id, user_id, amount, user_data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [transactionId, orderId, userId, numericAmount, JSON.stringify(userData)]);

    const transaction = result.rows[0];

    console.log(`Payment processed successfully: ${transactionId} for order ${orderId}`);
    
    res.json({
      status: 'paid',
      orderId,
      amount: numericAmount,
      transactionId,
      processedAt: transaction.created_at,
      user: userData
    });

  } catch (error) {
    console.error('Error processing payment:', error);
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
      return res.status(400).json({
        error: 'Missing required fields: transactionId and amount are required'
      });
    }

    // Find original transaction
    const transactionResult = await pool.query(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [transactionId]
    );

    if (transactionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const originalTransaction = transactionResult.rows[0];
    const refundAmount = parseFloat(amount);

    if (refundAmount > originalTransaction.amount) {
      return res.status(400).json({
        error: 'Refund amount cannot exceed original transaction amount'
      });
    }

    // Create refund
    const refundId = `refund_${Date.now()}_${transactionId}`;
    const refundResult = await pool.query(`
      INSERT INTO refunds (refund_id, original_transaction_id, amount, reason)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [refundId, transactionId, refundAmount, reason || 'order_cancellation']);

    console.log(`Refund processed: ${refundId} for transaction ${transactionId}`);
    
    res.json(refundResult.rows[0]);

  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).json({ error: 'Refund processing failed' });
  }
});

// Get payment history
app.get('/payments', async (req, res) => {
  try {
    const { orderId, userId, status, limit = 20, offset = 0 } = req.query;
    
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
    const countResult = await pool.query(countQuery, transactionId ? [transactionId] : []);

    res.json({
      refunds: result.rows,
      total: parseInt(countResult.rows[0].count),
      filtered: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching refunds:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get transaction status
app.get('/transactions/:id/status', async (req, res) => {
  try {
    const { id: transactionId } = req.params;

    const transactionResult = await pool.query(
      'SELECT * FROM transactions WHERE transaction_id = $1',
      [transactionId]
    );

    if (transactionResult.rows.length === 0) {
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

    res.json({
      transaction,
      refunds: refundsResult.rows,
      totalRefunded,
      netAmount: parseFloat(transaction.amount) - totalRefunded
    });
  } catch (error) {
    console.error('Error fetching transaction status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payment analytics
app.get('/analytics/payments', async (req, res) => {
  try {
    const totalTransactionsResult = await pool.query('SELECT COUNT(*) FROM transactions');
    const totalRefundsResult = await pool.query('SELECT COUNT(*) FROM refunds');
    const revenueResult = await pool.query('SELECT SUM(amount) as total_revenue FROM transactions');
    const refundAmountResult = await pool.query('SELECT SUM(amount) as total_refunds FROM refunds');
    const avgResult = await pool.query('SELECT AVG(amount) as avg_transaction FROM transactions');

    const totalRevenue = parseFloat(revenueResult.rows[0].total_revenue) || 0;
    const totalRefundAmount = parseFloat(refundAmountResult.rows[0].total_refunds) || 0;

    const analytics = {
      totalTransactions: parseInt(totalTransactionsResult.rows[0].count),
      totalRefunds: parseInt(totalRefundsResult.rows[0].count),
      totalRevenue,
      totalRefundAmount,
      netRevenue: totalRevenue - totalRefundAmount,
      averageTransactionValue: parseFloat(avgResult.rows[0].avg_transaction) || 0,
      successRate: 0.95, // Based on 5% failure rate
      generatedAt: new Date().toISOString()
    };

    res.json(analytics);
  } catch (error) {
    console.error('Error generating payment analytics:', error);
    res.status(500).json({ error: 'Failed to generate payment analytics' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'payment-service' });
  } catch (error) {
    res.status(500).json({ status: 'error', service: 'payment-service', error: 'Database connection failed' });
  }
});

app.get('/ready', (req, res) => res.sendStatus(200));

// Start server
const server = app.listen(port, () => {
  console.log(`Payment service running on port ${port}`);
  initDB();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down payment service...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
}); 

