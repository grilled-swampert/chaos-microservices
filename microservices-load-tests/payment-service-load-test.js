import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
export let errorRate = new Rate('errors');
export let paymentSuccessRate = new Rate('payment_success');
export let refundRate = new Rate('refunds');

// Test configuration
export let options = {
  stages: [
    { duration: '2m', target: 5 },  // Ramp up slowly for payment service
    { duration: '5m', target: 12 }, // Stay at 12 users
    { duration: '2m', target: 20 }, // Ramp up to 20
    { duration: '5m', target: 20 }, // Stay at 20
    { duration: '2m', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'], // 95% of requests under 3s (payment processing takes time)
    http_req_failed: ['rate<0.1'],     // Error rate under 10%
    errors: ['rate<0.1'],
    payment_success: ['rate>0.85'],    // At least 85% payment success (accounting for simulated failures)
  },
};

const BASE_URL = 'http://127.0.0.1:58179';

// Test data
const userIds = [1, 2, 3];
const orderIds = [];
const transactionIds = [];
const amounts = [99.99, 199.99, 299.99, 49.99, 599.99, 149.99, 399.99];

// Generate mock order IDs
for (let i = 1; i <= 50; i++) {
  orderIds.push(i);
}

export default function () {
  const userId = userIds[Math.floor(Math.random() * userIds.length)];
  
  // Test payment processing (50% chance)
  if (Math.random() < 0.5) {
    const transactionId = testPaymentProcessing(userId);
    if (transactionId) {
      transactionIds.push(transactionId);
      
      // Occasionally test transaction status (20% chance)
      if (Math.random() < 0.2) {
        sleep(1);
        testTransactionStatus(transactionId);
      }
    }
    sleep(2);
  }
  
  // Test refund processing (15% chance) - only if we have transactions
  if (Math.random() < 0.15 && transactionIds.length > 0) {
    const transactionId = transactionIds[Math.floor(Math.random() * transactionIds.length)];
    testRefundProcessing(transactionId);
    sleep(2);
  }
  
  // Test payment history (30% chance)
  if (Math.random() < 0.3) {
    testPaymentHistory(userId);
    sleep(1);
  }
  
  // Test refund history (20% chance)
  if (Math.random() < 0.2) {
    testRefundHistory();
    sleep(1);
  }
  
  // Test transaction status for random transaction (25% chance)
  if (Math.random() < 0.25 && transactionIds.length > 0) {
    const transactionId = transactionIds[Math.floor(Math.random() * transactionIds.length)];
    testTransactionStatus(transactionId);
    sleep(1);
  }
  
  // Test payment analytics (5% chance)
  if (Math.random() < 0.05) {
    testPaymentAnalytics();
    sleep(2);
  }
  
  // Test health endpoint occasionally
  if (Math.random() < 0.05) {
    testHealth();
  }
}

function testPaymentProcessing(userId) {
  const orderId = orderIds[Math.floor(Math.random() * orderIds.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  
  const payload = {
    orderId: orderId,
    amount: amount,
    userId: userId
  };
  
  const response = http.post(`${BASE_URL}/pay`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'payment status is 200 or 402': (r) => r.status === 200 || r.status === 402,
    'payment response structure': (r) => {
      try {
        const data = JSON.parse(r.body);
        if (r.status === 402) {
          // Payment failed - this is simulated behavior
          paymentSuccessRate.add(0);
          return data.error && data.orderId;
        } else if (r.status === 200) {
          // Payment successful
          paymentSuccessRate.add(1);
          return data.status === 'paid' && data.transactionId && data.orderId === orderId;
        }
        return false;
      } catch (e) {
        return false;
      }
    },
    'payment processing time reasonable': (r) => r.timings.duration < 5000,
  });
  
  if (!success) {
    errorRate.add(1);
    console.log(`Payment processing failed: ${response.status} ${response.body}`);
    return null;
  } else {
    errorRate.add(0);
    if (response.status === 200) {
      try {
        const data = JSON.parse(response.body);
        console.log(`Payment successful: ${data.transactionId} for order ${orderId}`);
        return data.transactionId;
      } catch (e) {
        return null;
      }
    } else {
      console.log(`Payment failed (simulated): Order ${orderId}`);
      return null;
    }
  }
}

function testRefundProcessing(transactionId) {
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const reasons = ['order_cancellation', 'defective_product', 'customer_request', 'duplicate_payment'];
  const reason = reasons[Math.floor(Math.random() * reasons.length)];
  
  const payload = {
    transactionId: transactionId,
    amount: amount,
    reason: reason
  };
  
  const response = http.post(`${BASE_URL}/refund`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'refund status is 200, 400, or 404': (r) => [200, 400, 404].includes(r.status),
    'refund response structure': (r) => {
      if (r.status === 400 || r.status === 404) return true; // Expected validation errors
      try {
        const data = JSON.parse(r.body);
        return data.refundId && data.originalTransactionId === transactionId && data.status === 'processed';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
    refundRate.add(0);
  } else {
    errorRate.add(0);
    if (response.status === 200) {
      refundRate.add(1);
      try {
        const data = JSON.parse(response.body);
        console.log(`Refund processed: ${data.refundId} for transaction ${transactionId}`);
      } catch (e) {
        // Ignore parsing errors
      }
    } else {
      refundRate.add(0);
    }
  }
}

function testPaymentHistory(userId) {
  const params = Math.random() < 0.5 ? `?userId=${userId}&limit=10` : `?status=paid`;
  const response = http.get(`${BASE_URL}/payments${params}`);
  
  const success = check(response, {
    'payment history status is 200': (r) => r.status === 200,
    'payment history has transactions array': (r) => {
      try {
        const data = JSON.parse(r.body);
        return Array.isArray(data.transactions) && typeof data.total === 'number';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }
}

function testRefundHistory() {
  const params = Math.random() < 0.5 ? '?limit=5' : '';
  const response = http.get(`${BASE_URL}/refunds${params}`);
  
  const success = check(response, {
    'refund history status is 200': (r) => r.status === 200,
    'refund history has refunds array': (r) => {
      try {
        const data = JSON.parse(r.body);
        return Array.isArray(data.refunds) && typeof data.total === 'number';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }
}

function testTransactionStatus(transactionId) {
  const response = http.get(`${BASE_URL}/transactions/${transactionId}/status`);
  
  const success = check(response, {
    'transaction status is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'transaction status response structure': (r) => {
      if (r.status === 404) return true; // Transaction might not exist
      try {
        const data = JSON.parse(r.body);
        return data.transaction && data.refunds !== undefined && data.netAmount !== undefined;
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }
}

function testPaymentAnalytics() {
  const response = http.get(`${BASE_URL}/analytics/payments`);
  
  const success = check(response, {
    'payment analytics status is 200': (r) => r.status === 200,
    'payment analytics has required data': (r) => {
      try {
        const data = JSON.parse(r.body);
        return typeof data.totalTransactions === 'number' && 
               typeof data.totalRevenue === 'number' && 
               typeof data.netRevenue === 'number' &&
               typeof data.successRate === 'number';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }
}

function testHealth() {
  const response = http.get(`${BASE_URL}/health`);
  
  check(response, {
    'health endpoint responds': (r) => r.status === 200 || r.status === 503,
    'health has status field': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.status;
      } catch (e) {
        return false;
      }
    },
  });
}

// Setup function to create some initial transactions
export function setup() {
  console.log('Setting up initial transactions for testing...');
  
  // Create a few successful transactions to start with
  for (let i = 0; i < 5; i++) {
    const userId = userIds[i % userIds.length];
    const orderId = orderIds[i];
    const amount = amounts[i % amounts.length];
    
    const payload = {
      orderId: orderId,
      amount: amount,
      userId: userId
    };
    
    const response = http.post(`${BASE_URL}/pay`, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (response.status === 200) {
      try {
        const data = JSON.parse(response.body);
        transactionIds.push(data.transactionId);
        console.log(`Setup created transaction ${data.transactionId}`);
      } catch (e) {
        // Ignore parsing errors during setup
      }
    }
    
    sleep(0.5);
  }
  
  console.log(`Setup complete. Created ${transactionIds.length} initial transactions.`);
  return { initialTransactionIds: transactionIds };
}

// Webhook endpoint test (simulates external service calling payment service)
export function testWebhookUserActivity() {
  if (Math.random() < 0.1) { // 10% chance to test webhook
    const payload = {
      userId: userIds[Math.floor(Math.random() * userIds.length)],
      action: 'login',
      sessionId: `session_${Date.now()}`,
      timestamp: new Date().toISOString(),
      ipAddress: `192.168.1.${Math.floor(Math.random() * 255)}`
    };
    
    const response = http.post(`${BASE_URL}/webhooks/user-activity`, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    // Webhooks might not be implemented, so we're lenient with status codes
    check(response, {
      'webhook status is acceptable': (r) => [200, 404, 501].includes(r.status),
    });
  }
}

// Handle summary data
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'payment-service-results.json': JSON.stringify(data),
  };
}