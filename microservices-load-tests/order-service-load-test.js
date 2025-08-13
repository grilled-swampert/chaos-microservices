import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
export let errorRate = new Rate('errors');
export let orderCreationRate = new Rate('order_creations');

// Test configuration
export let options = {
  stages: [
    { duration: '2m', target: 8 },  // Ramp up
    { duration: '5m', target: 15 }, // Stay at 15 users
    { duration: '2m', target: 25 }, // Ramp up to 25
    { duration: '5m', target: 25 }, // Stay at 25
    { duration: '2m', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% of requests under 2s
    http_req_failed: ['rate<0.15'],    // Error rate under 15% (accounting for dependency failures)
    errors: ['rate<0.15'],
  },
};

const BASE_URL = 'http://microservices.local/orders';

// Test data
const userIds = [1, 2, 3];
const products = [
  { name: 'Laptop', category: 'Electronics', brand: 'Dell' },
  { name: 'Coffee Mug', category: 'Kitchen', brand: 'Generic' },
  { name: 'Book', category: 'Education', title: 'Node.js Guide' },
  { name: 'Headphones', category: 'Electronics', brand: 'Sony' },
  { name: 'T-Shirt', category: 'Clothing', size: 'M' }
];

const amounts = [299.99, 49.99, 599.99, 199.99, 29.99, 899.99, 149.99];

// Global variable to track created order IDs for testing
let createdOrderIds = [];

export default function () {
  const userId = userIds[Math.floor(Math.random() * userIds.length)];
  
  // Test order creation (40% chance)
  if (Math.random() < 0.4) {
    const orderId = testOrderCreation(userId);
    if (orderId) {
      createdOrderIds.push(orderId);
      
      // Occasionally pay for the order we just created (60% chance)
      if (Math.random() < 0.6) {
        sleep(1);
        testOrderPayment(orderId);
      }
    }
    sleep(2);
  }
  
  // Test getting all orders (50% chance)
  if (Math.random() < 0.5) {
    testGetOrders(userId);
    sleep(1);
  }
  
  // Test getting specific order (30% chance)
  if (Math.random() < 0.3 && createdOrderIds.length > 0) {
    const randomOrderId = createdOrderIds[Math.floor(Math.random() * createdOrderIds.length)];
    testGetSpecificOrder(randomOrderId);
    sleep(1);
  }
  
  // Test order cancellation (10% chance)
  if (Math.random() < 0.1 && createdOrderIds.length > 0) {
    const orderToCancel = createdOrderIds.splice(0, 1)[0]; // Remove from array
    testOrderCancellation(orderToCancel);
    sleep(2);
  }
  
  // Test analytics (5% chance)
  if (Math.random() < 0.05) {
    testOrderAnalytics();
    sleep(2);
  }
  
  // Test health endpoint occasionally
  if (Math.random() < 0.05) {
    testHealth();
  }
}

function testOrderCreation(userId) {
  const product = products[Math.floor(Math.random() * products.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  
  const payload = {
    userId: userId,
    product: product,
    amount: amount
  };
  
  const response = http.post(`${BASE_URL}/orders`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'order creation status is 201 or 503/504': (r) => [201, 503, 504].includes(r.status),
    'order creation has valid response': (r) => {
      if (r.status === 503 || r.status === 504) return true; // Service issues are acceptable
      if (r.status === 404) return true; // User not found is acceptable for testing
      try {
        const data = JSON.parse(r.body);
        return data.id && data.user && data.product && data.status === 'pending';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
    orderCreationRate.add(0);
    return null;
  } else {
    errorRate.add(0);
    if (response.status === 201) {
      orderCreationRate.add(1);
      try {
        const data = JSON.parse(response.body);
        console.log(`Created order ${data.id} for user ${userId}`);
        return data.id;
      } catch (e) {
        return null;
      }
    } else {
      orderCreationRate.add(0);
      return null;
    }
  }
}

function testGetOrders(userId) {
  const params = Math.random() < 0.5 ? `?userId=${userId}` : '';
  const response = http.get(`${BASE_URL}/orders${params}`);
  
  const success = check(response, {
    'get orders status is 200': (r) => r.status === 200,
    'get orders has orders array': (r) => {
      try {
        const data = JSON.parse(r.body);
        return Array.isArray(data.orders) && typeof data.total === 'number';
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

function testGetSpecificOrder(orderId) {
  const response = http.get(`${BASE_URL}/orders/${orderId}`);
  
  const success = check(response, {
    'get specific order status is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'get specific order has valid data': (r) => {
      if (r.status === 404) return true; // Order might have been deleted
      try {
        const data = JSON.parse(r.body);
        return data.id === orderId && data.user && data.product;
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

function testOrderPayment(orderId) {
  const response = http.post(`${BASE_URL}/orders/${orderId}/pay`, null, {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'order payment status is 200, 400, 404, 503, or 504': (r) => 
      [200, 400, 404, 503, 504].includes(r.status),
    'order payment response structure': (r) => {
      if ([400, 404, 503, 504].includes(r.status)) return true; // Expected errors
      try {
        const data = JSON.parse(r.body);
        return data.order && data.payment && data.order.status === 'paid';
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
    console.log(`Payment failed for order ${orderId}: ${response.status} ${response.body}`);
  } else {
    errorRate.add(0);
    if (response.status === 200) {
      console.log(`Payment successful for order ${orderId}`);
    }
  }
}

function testOrderCancellation(orderId) {
  const response = http.del(`${BASE_URL}/orders/${orderId}`);
  
  const success = check(response, {
    'order cancellation status is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'order cancellation response': (r) => {
      if (r.status === 404) return true; // Order might already be deleted
      try {
        const data = JSON.parse(r.body);
        return data.message && data.cancelledOrder;
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
    if (response.status === 200) {
      console.log(`Cancelled order ${orderId}`);
    }
  }
}

function testOrderAnalytics() {
  const response = http.get(`${BASE_URL}/analytics/orders`);
  
  const success = check(response, {
    'analytics status is 200': (r) => r.status === 200,
    'analytics has required data': (r) => {
      try {
        const data = JSON.parse(r.body);
        return typeof data.totalOrders === 'number' && 
               data.ordersByStatus && 
               typeof data.totalRevenue === 'number';
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

// Setup function to initialize some orders
export function setup() {
  console.log('Setting up initial orders for testing...');
  
  // Create a few orders to start with
  for (let i = 0; i < 3; i++) {
    const userId = userIds[i % userIds.length];
    const product = products[i % products.length];
    const amount = amounts[i % amounts.length];
    
    const payload = {
      userId: userId,
      product: product,
      amount: amount
    };
    
    const response = http.post(`${BASE_URL}/orders`, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (response.status === 201) {
      try {
        const data = JSON.parse(response.body);
        createdOrderIds.push(data.id);
        console.log(`Setup created order ${data.id}`);
      } catch (e) {
        // Ignore parsing errors during setup
      }
    }
    
    sleep(0.5);
  }
  
  console.log(`Setup complete. Created ${createdOrderIds.length} initial orders.`);
  return { initialOrderIds: createdOrderIds };
}

// Handle setup data
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'order-service-results.json': JSON.stringify(data),
  };
}