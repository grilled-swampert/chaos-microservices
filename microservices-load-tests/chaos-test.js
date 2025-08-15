import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics to track failures and response times
export let errorRate = new Rate('errors');
export let responseTime = new Trend('response_time');
export let requestCount = new Counter('total_requests');

// Test configuration
export let options = {
  stages: [
    { duration: '2m', target: 10 },   // Ramp up to 10 users
    { duration: '10m', target: 10 },  // Stay at 10 users for 10 minutes
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% of requests should be below 2s
    errors: ['rate<0.3'],              // Error rate should be below 30% during chaos
  },
    ext: {
    loadimpact: {
      projectID: 1234567,  // optional
      // push metrics to Prometheus
      prometheus: {
        pushGatewayURL: 'http://<prometheus-pushgateway-service>:9091',
      },
    },
  },
};

// Base URLs - adjust these based on your cluster setup
const BASE_URLS = {
  user: 'http://microservices.local/users',
  order: 'http://microservices.local/orders', 
  payment: 'http://microservices.local/payment',
};

// Sample data
const USERS = [1, 2, 3];
const PRODUCTS = ['Laptop', 'Phone', 'Tablet', 'Headphones', 'Mouse'];
const AMOUNTS = [299.99, 599.99, 899.99, 149.99, 49.99];

// Helper function to make requests with error handling
function makeRequest(method, url, payload = null, params = {}) {
  requestCount.add(1);
  
  const options = {
    timeout: '10s',
    ...params,
  };
  
  let response;
  if (method === 'GET') {
    response = http.get(url, options);
  } else if (method === 'POST') {
    response = http.post(url, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } else if (method === 'PUT') {
    response = http.put(url, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  }
  
  // Track metrics
  responseTime.add(response.timings.duration);
  errorRate.add(response.status >= 400 || response.status === 0);
  
  return response;
}

// Test scenarios
export default function() {
  const userId = USERS[Math.floor(Math.random() * USERS.length)];
  const scenario = Math.floor(Math.random() * 100);
  
  // 40% - User operations (affected by user-service pod kills)
  if (scenario < 40) {
    userOperations(userId);
  }
  // 35% - Order operations (affected by order-service CPU stress & IO slowdown)
  else if (scenario < 75) {
    orderOperations(userId);
  }
  // 25% - Payment operations (affected by payment-service network latency)
  else {
    paymentOperations(userId);
  }
  
  sleep(Math.random() * 3 + 1); // Random sleep 1-4 seconds
}

function userOperations(userId) {
  console.log(`🧑 User operations for user ${userId}`);
  
  // Get user profile - frequently called, will show user-service pod kills
  let response = makeRequest('GET', `${BASE_URLS.user}/users/${userId}`);
  check(response, {
    'user fetch status is 200': (r) => r.status === 200,
    'user fetch has name': (r) => r.json('name') !== undefined,
  });
  
  // Get full profile
  response = makeRequest('GET', `${BASE_URLS.user}/users/${userId}/profile`);
  check(response, {
    'profile fetch status is 200': (r) => r.status === 200,
  });
  
  // Get user orders (cross-service call to order-service)
  response = makeRequest('GET', `${BASE_URLS.user}/users/${userId}/orders`);
  check(response, {
    'user orders status is 200 or 503': (r) => r.status === 200 || r.status === 503,
  });
  
  // Update user profile occasionally
  if (Math.random() < 0.3) {
    const updateData = {
      preferences: {
        currency: 'INR',
        language: Math.random() < 0.5 ? 'en' : 'hi',
        notifications: Math.random() < 0.7,
      }
    };
    
    response = makeRequest('PUT', `${BASE_URLS.user}/users/${userId}/profile`, updateData);
    check(response, {
      'profile update status is 200': (r) => r.status === 200,
    });
  }
}

function orderOperations(userId) {
  console.log(`📦 Order operations for user ${userId}`);
  
  // Get user orders - will be affected by order-service CPU stress
  let response = makeRequest('GET', `${BASE_URLS.order}/orders?userId=${userId}`);
  check(response, {
    'get orders status is 200': (r) => r.status === 200,
    'get orders has data': (r) => r.json('orders') !== undefined,
  });
  
  // Create new order occasionally - CPU intensive operation
  if (Math.random() < 0.4) {
    const orderData = {
      userId: userId,
      product: PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)],
      amount: AMOUNTS[Math.floor(Math.random() * AMOUNTS.length)],
    };
    
    response = makeRequest('POST', `${BASE_URLS.order}/orders`, orderData);
    check(response, {
      'create order status is 201 or 503': (r) => r.status === 201 || r.status === 503,
    });
    
    // If order created successfully, try to process payment
    if (response.status === 201) {
      const order = response.json();
      sleep(1); // Brief pause
      
      response = makeRequest('POST', `${BASE_URLS.order}/orders/${order.id}/pay`);
      check(response, {
        'process payment status is 200 or 4xx or 5xx': (r) => r.status >= 200,
      });
    }
  }
  
  // Get order analytics - database intensive, affected by IO slowdown
  response = makeRequest('GET', `${BASE_URLS.order}/analytics/orders`);
  check(response, {
    'order analytics status is 200': (r) => r.status === 200,
    'analytics has total orders': (r) => r.json('totalOrders') !== undefined,
  });
}

function paymentOperations(userId) {
  console.log(`💳 Payment operations for user ${userId}`);
  
  // Get payment history - will be affected by payment-service network latency
  let response = makeRequest('GET', `${BASE_URLS.payment}/payments?userId=${userId}`);
  check(response, {
    'get payments status is 200': (r) => r.status === 200,
    'get payments has transactions': (r) => r.json('transactions') !== undefined,
  });
  
  // Direct payment processing - will show latency effects
  if (Math.random() < 0.3) {
    const paymentData = {
      orderId: Math.floor(Math.random() * 1000) + 1,
      amount: AMOUNTS[Math.floor(Math.random() * AMOUNTS.length)],
      userId: userId,
    };
    
    response = makeRequest('POST', `${BASE_URLS.payment}/pay`, paymentData);
    check(response, {
      'direct payment status is 200 or 402': (r) => r.status === 200 || r.status === 402,
    });
  }
  
  // Get payment analytics
  response = makeRequest('GET', `${BASE_URLS.payment}/analytics/payments`);
  check(response, {
    'payment analytics status is 200': (r) => r.status === 200,
    'analytics has total transactions': (r) => r.json('totalTransactions') !== undefined,
  });
  
  // Check transaction status occasionally
  if (Math.random() < 0.2) {
    const transactionId = `txn_${Date.now()}_${Math.floor(Math.random() * 100)}`;
    response = makeRequest('GET', `${BASE_URLS.payment}/transactions/${transactionId}/status`);
    check(response, {
      'transaction status check returns response': (r) => r.status === 200 || r.status === 404,
    });
  }
}

// Health check scenario - runs every 30 seconds
export function healthCheck() {
  console.log('🏥 Health check round');
  
  const services = [
    { name: 'user-service', url: `${BASE_URLS.user}/health` },
    { name: 'order-service', url: `${BASE_URLS.order}/health` },
    { name: 'payment-service', url: `${BASE_URLS.payment}/health` },
  ];
  
  services.forEach(service => {
    const response = makeRequest('GET', service.url);
    check(response, {
      [`${service.name} health check responds`]: (r) => r.status >= 200 && r.status < 600,
    });
    
    if (response.status === 200) {
      const health = response.json();
      console.log(`✅ ${service.name}: ${health.status || 'ok'}`);
    } else {
      console.log(`❌ ${service.name}: status ${response.status}`);
    }
  });
}

// Setup and teardown
export function setup() {
  console.log('🚀 Starting chaos testing...');
  console.log('Chaos experiments will affect:');
  console.log('- user-service: Pod kills every 1min for 30s');
  console.log('- payment-service: 500ms latency every 2min for 1min');
  console.log('- order-service: CPU stress every 3min for 45s');
  console.log('- order-service: IO slowdown every 4min for 40s');
}

export function teardown() {
  console.log('🏁 Chaos testing completed');
}