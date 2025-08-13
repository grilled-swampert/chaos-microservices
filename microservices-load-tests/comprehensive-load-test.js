import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// Custom metrics
export let errorRate = new Rate('errors');
export let userServiceRequests = new Counter('user_service_requests');
export let orderServiceRequests = new Counter('order_service_requests');
export let paymentServiceRequests = new Counter('payment_service_requests');
export let endToEndDuration = new Trend('end_to_end_duration');

// Test configuration for comprehensive load testing
export let options = {
  stages: [
    { duration: '3m', target: 20 }, // Ramp up to 20 users
    { duration: '10m', target: 40 }, // Stay at 40 users for main test
    { duration: '2m', target: 60 }, // Spike to 60 users
    { duration: '3m', target: 40 }, // Back to 40 users
    { duration: '5m', target: 40 }, // Continue steady load
    { duration: '3m', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'], // 95% of requests under 3s
    http_req_failed: ['rate<0.2'],     // Error rate under 20% (accounting for chaos experiments)
    errors: ['rate<0.2'],
    end_to_end_duration: ['p(90)<10000'], // 90% of end-to-end flows under 10s
  },
};

const USER_SERVICE_URL = 'http://microservices.local/users';
const ORDER_SERVICE_URL = 'http://microservices.local/orders';
const PAYMENT_SERVICE_URL = 'http://microservices.local/payment';

// Test data
const userIds = [1, 2, 3];
const products = [
  { name: 'Gaming Laptop', category: 'Electronics', brand: 'ASUS' },
  { name: 'Smartphone', category: 'Electronics', brand: 'Samsung' },
  { name: 'Coffee Machine', category: 'Appliances', brand: 'Nespresso' },
  { name: 'Running Shoes', category: 'Sports', brand: 'Nike' },
  { name: 'Bluetooth Speaker', category: 'Audio', brand: 'JBL' }
];
const amounts = [899.99, 699.99, 299.99, 129.99, 79.99];

// Tracking for realistic workflows
let createdOrderIds = [];
let transactionIds = [];
let sessionIds = [];

export default function () {
  const userId = userIds[Math.floor(Math.random() * userIds.length)];
  
  // Choose a workflow based on probability
  const workflow = Math.random();
  
  if (workflow < 0.4) {
    // 40% - Complete purchase workflow
    completePurchaseWorkflow(userId);
  } else if (workflow < 0.6) {
    // 20% - User browsing and profile management
    userBrowsingWorkflow(userId);
  } else if (workflow < 0.8) {
    // 20% - Order management workflow
    orderManagementWorkflow(userId);
  } else if (workflow < 0.9) {
    // 10% - Payment and refund workflow
    paymentWorkflow();
  } else {
    // 10% - Analytics and health checks
    analyticsWorkflow();
  }
  
  sleep(Math.random() * 2 + 1); // Random sleep between 1-3 seconds
}

function completePurchaseWorkflow(userId) {
  const startTime = Date.now();
  console.log(`Starting complete purchase workflow for user ${userId}`);
  
  // Step 1: User login/session creation
  const sessionSuccess = createUserSession(userId);
  if (!sessionSuccess) return;
  
  sleep(0.5);
  
  // Step 2: Browse user profile
  getUserProfile(userId);
  
  sleep(0.5);
  
  // Step 3: Create order
  const orderId = createOrder(userId);
  if (!orderId) return;
  
  sleep(1);
  
  // Step 4: Process payment
  const success = processOrderPayment(orderId);
  
  if (success) {
    const duration = Date.now() - startTime;
    endToEndDuration.add(duration);
    console.log(`Completed purchase workflow in ${duration}ms for user ${userId}`);
  }
}

function userBrowsingWorkflow(userId) {
  console.log(`Starting browsing workflow for user ${userId}`);
  
  // Browse user info
  getUserInfo(userId);
  sleep(0.5);
  
  // Check user activity
  getUserActivity(userId);
  sleep(0.5);
  
  // Update profile occasionally
  if (Math.random() < 0.3) {
    updateUserProfile(userId);
    sleep(1);
  }
  
  // Browse orders
  getUserOrders(userId);
  sleep(0.5);
  
  // Check payment history
  getUserPayments(userId);
}

function orderManagementWorkflow(userId) {
  console.log(`Starting order management workflow for user ${userId}`);
  
  // Get all orders
  getAllOrders(userId);
  sleep(0.5);
  
  // Create new order occasionally
  if (Math.random() < 0.4) {
    const orderId = createOrder(userId);
    if (orderId) {
      createdOrderIds.push(orderId);
      sleep(1);
      
      // Sometimes cancel the order
      if (Math.random() < 0.2) {
        cancelOrder(orderId);
        // Remove from tracking since it's cancelled
        const index = createdOrderIds.indexOf(orderId);
        if (index > -1) createdOrderIds.splice(index, 1);
      }
    }
  }
  
  // Check specific order if we have any
  if (createdOrderIds.length > 0) {
    const orderId = createdOrderIds[Math.floor(Math.random() * createdOrderIds.length)];
    getSpecificOrder(orderId);
  }
}

function paymentWorkflow() {
  console.log('Starting payment workflow');
  
  // Check payment history
  getPaymentHistory();
  sleep(0.5);
  
  // Check refund history
  getRefundHistory();
  sleep(0.5);
  
  // Process refund if we have transactions
  if (transactionIds.length > 0 && Math.random() < 0.3) {
    const transactionId = transactionIds[Math.floor(Math.random() * transactionIds.length)];
    processRefund(transactionId);
    sleep(1);
  }
  
  // Check transaction status
  if (transactionIds.length > 0) {
    const transactionId = transactionIds[Math.floor(Math.random() * transactionIds.length)];
    getTransactionStatus(transactionId);
  }
}

function analyticsWorkflow() {
  console.log('Starting analytics workflow');
  
  // User analytics
  getUserAnalytics();
  sleep(1);
  
  // Order analytics
  getOrderAnalytics();
  sleep(1);
  
  // Payment analytics
  getPaymentAnalytics();
  sleep(1);
  
  // Health checks
  checkUserServiceHealth();
  sleep(0.5);
  checkOrderServiceHealth();
  sleep(0.5);
  checkPaymentServiceHealth();
}

// Individual service functions
function getUserInfo(userId) {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/users/${userId}`);
  
  const success = check(response, {
    'user info status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getUserProfile(userId) {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/users/${userId}/profile`);
  
  const success = check(response, {
    'user profile status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function createUserSession(userId) {
  userServiceRequests.add(1);
  const payload = {
    deviceInfo: 'k6-load-test-client',
    ipAddress: `10.0.0.${Math.floor(Math.random() * 255)}`
  };
  
  const response = http.post(`${USER_SERVICE_URL}/users/${userId}/sessions`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'session creation status ok': (r) => r.status === 201,
  });
  
  if (success) {
    try {
      const data = JSON.parse(response.body);
      sessionIds.push(data.sessionId);
      return true;
    } catch (e) {
      return false;
    }
  } else {
    errorRate.add(1);
    return false;
  }
}

function getUserActivity(userId) {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/users/${userId}/activity?limit=10`);
  
  const success = check(response, {
    'user activity status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function updateUserProfile(userId) {
  userServiceRequests.add(1);
  const updates = {
    preferences: { notifications: Math.random() < 0.5 }
  };
  
  const response = http.put(`${USER_SERVICE_URL}/users/${userId}/profile`, JSON.stringify(updates), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'profile update status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getUserOrders(userId) {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/users/${userId}/orders`);
  
  // Accept both success and service unavailable
  const success = check(response, {
    'user orders status acceptable': (r) => r.status === 200 || r.status === 503,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getUserPayments(userId) {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/users/${userId}/payments`);
  
  const success = check(response, {
    'user payments status acceptable': (r) => r.status === 200 || r.status === 503,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function createOrder(userId) {
  orderServiceRequests.add(1);
  const product = products[Math.floor(Math.random() * products.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  
  const payload = {
    userId: userId,
    product: product,
    amount: amount
  };
  
  const response = http.post(`${ORDER_SERVICE_URL}/orders`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'order creation status acceptable': (r) => [201, 503, 504].includes(r.status),
  });
  
  if (success && response.status === 201) {
    try {
      const data = JSON.parse(response.body);
      console.log(`Created order ${data.id} for user ${userId}`);
      return data.id;
    } catch (e) {
      return null;
    }
  } else {
    if (!success) errorRate.add(1);
    return null;
  }
}

function getAllOrders(userId) {
  orderServiceRequests.add(1);
  const response = http.get(`${ORDER_SERVICE_URL}/orders?userId=${userId}`);
  
  const success = check(response, {
    'get orders status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getSpecificOrder(orderId) {
  orderServiceRequests.add(1);
  const response = http.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
  
  const success = check(response, {
    'get specific order status acceptable': (r) => r.status === 200 || r.status === 404,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function processOrderPayment(orderId) {
  orderServiceRequests.add(1);
  const response = http.post(`${ORDER_SERVICE_URL}/orders/${orderId}/pay`, null);
  
  const success = check(response, {
    'order payment status acceptable': (r) => [200, 400, 404, 503, 504].includes(r.status),
  });
  
  if (success && response.status === 200) {
    try {
      const data = JSON.parse(response.body);
      if (data.payment && data.payment.transactionId) {
        transactionIds.push(data.payment.transactionId);
        console.log(`Payment successful: ${data.payment.transactionId}`);
        return true;
      }
    } catch (e) {
      // Ignore parsing errors
    }
  } else if (!success) {
    errorRate.add(1);
  }
  
  return false;
}

function cancelOrder(orderId) {
  orderServiceRequests.add(1);
  const response = http.del(`${ORDER_SERVICE_URL}/orders/${orderId}`);
  
  const success = check(response, {
    'order cancellation status acceptable': (r) => r.status === 200 || r.status === 404,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getPaymentHistory() {
  paymentServiceRequests.add(1);
  const response = http.get(`${PAYMENT_SERVICE_URL}/payments?limit=10`);
  
  const success = check(response, {
    'payment history status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getRefundHistory() {
  paymentServiceRequests.add(1);
  const response = http.get(`${PAYMENT_SERVICE_URL}/refunds?limit=5`);
  
  const success = check(response, {
    'refund history status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function processRefund(transactionId) {
  paymentServiceRequests.add(1);
  const payload = {
    transactionId: transactionId,
    amount: amounts[Math.floor(Math.random() * amounts.length)],
    reason: 'load_test_refund'
  };
  
  const response = http.post(`${PAYMENT_SERVICE_URL}/refund`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'refund status acceptable': (r) => [200, 400, 404].includes(r.status),
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getTransactionStatus(transactionId) {
  paymentServiceRequests.add(1);
  const response = http.get(`${PAYMENT_SERVICE_URL}/transactions/${transactionId}/status`);
  
  const success = check(response, {
    'transaction status acceptable': (r) => r.status === 200 || r.status === 404,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getUserAnalytics() {
  userServiceRequests.add(1);
  const response = http.get(`${USER_SERVICE_URL}/analytics/users`);
  
  const success = check(response, {
    'user analytics status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getOrderAnalytics() {
  orderServiceRequests.add(1);
  const response = http.get(`${ORDER_SERVICE_URL}/analytics/orders`);
  
  const success = check(response, {
    'order analytics status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function getPaymentAnalytics() {
  paymentServiceRequests.add(1);
  const response = http.get(`${PAYMENT_SERVICE_URL}/analytics/payments`);
  
  const success = check(response, {
    'payment analytics status ok': (r) => r.status === 200,
  });
  
  if (!success) errorRate.add(1);
  else errorRate.add(0);
}

function checkUserServiceHealth() {
  const response = http.get(`${USER_SERVICE_URL}/health`);
  
  check(response, {
    'user service health responds': (r) => r.status === 200 || r.status === 503,
  });
}

function checkOrderServiceHealth() {
  const response = http.get(`${ORDER_SERVICE_URL}/health`);
  
  check(response, {
    'order service health responds': (r) => r.status === 200 || r.status === 503,
  });
}

function checkPaymentServiceHealth() {
  const response = http.get(`${PAYMENT_SERVICE_URL}/health`);
  
  check(response, {
    'payment service health responds': (r) => r.status === 200 || r.status === 503,
  });
}

// Setup function to initialize data
export function setup() {
  console.log('Setting up comprehensive load test...');
  
  // Create some initial orders and transactions
  for (let i = 0; i < 3; i++) {
    const userId = userIds[i % userIds.length];
    const product = products[i % products.length];
    const amount = amounts[i % amounts.length];
    
    // Create order
    const orderPayload = { userId, product, amount };
    const orderResponse = http.post(`${ORDER_SERVICE_URL}/orders`, JSON.stringify(orderPayload), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (orderResponse.status === 201) {
      const orderData = JSON.parse(orderResponse.body);
      createdOrderIds.push(orderData.id);
      
      // Create a payment for the order
      const paymentResponse = http.post(`${ORDER_SERVICE_URL}/orders/${orderData.id}/pay`, null);
      if (paymentResponse.status === 200) {
        const paymentData = JSON.parse(paymentResponse.body);
        if (paymentData.payment && paymentData.payment.transactionId) {
          transactionIds.push(paymentData.payment.transactionId);
        }
      }
    }
    
    sleep(0.5);
  }
  
  console.log(`Setup complete. Created ${createdOrderIds.length} orders and ${transactionIds.length} transactions.`);
  return { 
    initialOrders: createdOrderIds.length,
    initialTransactions: transactionIds.length 
  };
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'comprehensive-results.json': JSON.stringify(data),
  };
}