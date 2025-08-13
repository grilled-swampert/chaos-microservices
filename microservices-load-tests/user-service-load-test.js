import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
export let errorRate = new Rate('errors');

// Test configuration
export let options = {
  stages: [
    { duration: '2m', target: 10 }, // Ramp up
    { duration: '5m', target: 20 }, // Stay at 20 users
    { duration: '2m', target: 30 }, // Ramp up to 30
    { duration: '5m', target: 30 }, // Stay at 30
    { duration: '2m', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'], // 95% of requests under 1s
    http_req_failed: ['rate<0.1'],     // Error rate under 10%
    errors: ['rate<0.1'],
  },
};

const BASE_URL = 'http://127.0.0.1:59842';

// Test data
const userIds = [1, 2];
const updateData = [
  { name: 'Alice Updated', phone: '+91-9876543999' },
  { email: 'bob.new@example.com', preferences: { notifications: true } },
  { address: { street: '999 New Street', city: 'Mumbai' } }
];

const deviceInfos = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
];

export default function () {
  const userId = userIds[Math.floor(Math.random() * userIds.length)];
  
  // Test user lookup (most common operation)
  testUserLookup(userId);
  sleep(1);
  
  // Test user profile (30% chance)
  if (Math.random() < 0.3) {
    testUserProfile(userId);
    sleep(1);
  }
  
  // Test user activity (20% chance)
  if (Math.random() < 0.2) {
    testUserActivity(userId);
    sleep(1);
  }
  
  // Test user session creation (15% chance)
  if (Math.random() < 0.15) {
    testUserSession(userId);
    sleep(1);
  }
  
  // Test profile update (10% chance)
  if (Math.random() < 0.1) {
    testProfileUpdate(userId);
    sleep(2);
  }
  
  // Test users list (5% chance)
  if (Math.random() < 0.05) {
    testUsersList();
    sleep(1);
  }
  
  // Test orders endpoint (25% chance)
  if (Math.random() < 0.25) {
    testUserOrders(userId);
    sleep(1);
  }
  
  // Test payments endpoint (20% chance)
  if (Math.random() < 0.2) {
    testUserPayments(userId);
    sleep(1);
  }
  
  // Test analytics (very rare, 2% chance)
  if (Math.random() < 0.02) {
    testAnalytics();
    sleep(2);
  }
  
  // Test health endpoint occasionally
  if (Math.random() < 0.05) {
    testHealth();
  }
}

function testUserLookup(userId) {
  const response = http.get(`${BASE_URL}/users/${userId}`);
  
  const success = check(response, {
    'user lookup status is 200': (r) => r.status === 200,
    'user lookup has user data': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.id && data.name ;
      } catch (e) {
        return false;
      }
    },
    'user lookup response time < 500ms': (r) => r.timings.duration < 500,
  });
  
  if (!success) {
    errorRate.add(1);
    console.log(`User lookup failed for ID ${userId}: ${response.status} ${response.body}`);
  } else {
    errorRate.add(0);
  }
}

function testUserProfile(userId) {
  const response = http.get(`${BASE_URL}/users/${userId}/profile`);
  
  const success = check(response, {
    'profile status is 200': (r) => r.status === 200,
    'profile has detailed data': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.demographics && data.address && data.preferences;
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

function testUserActivity(userId) {
  const params = Math.random() < 0.5 ? `?limit=10` : '';
  const response = http.get(`${BASE_URL}/users/${userId}/activity${params}`);
  
  const success = check(response, {
    'activity status is 200': (r) => r.status === 200,
    'activity has activities array': (r) => {
      try {
        const data = JSON.parse(r.body);
        return Array.isArray(data.activities);
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

function testUserSession(userId) {
  const payload = {
    deviceInfo: deviceInfos[Math.floor(Math.random() * deviceInfos.length)],
    ipAddress: `192.168.1.${Math.floor(Math.random() * 255)}`
  };
  
  const response = http.post(`${BASE_URL}/users/${userId}/sessions`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'session creation status is 201': (r) => r.status === 201,
    'session has sessionId': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.sessionId && data.status === 'active';
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

function testProfileUpdate(userId) {
  const update = updateData[Math.floor(Math.random() * updateData.length)];
  
  const response = http.put(`${BASE_URL}/users/${userId}/profile`, JSON.stringify(update), {
    headers: { 'Content-Type': 'application/json' },
  });
  
  const success = check(response, {
    'profile update status is 200': (r) => r.status === 200,
    'profile update has updatedAt': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.updatedAt;
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

function testUsersList() {
  const params = Math.random() < 0.5 ? `?limit=5&offset=0` : '';
  const response = http.get(`${BASE_URL}/users${params}`);
  
  const success = check(response, {
    'users list status is 200': (r) => r.status === 200,
    'users list has users array': (r) => {
      try {
        const data = JSON.parse(r.body);
        return Array.isArray(data.users);
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

function testUserOrders(userId) {
  const response = http.get(`${BASE_URL}/users/${userId}/orders`);
  
  const success = check(response, {
    'user orders status is 200 or 503': (r) => r.status === 200 || r.status === 503,
    'user orders response structure': (r) => {
      if (r.status === 503) return true; // Service unavailable is acceptable
      try {
        const data = JSON.parse(r.body);
        return data.user && data.orders;
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

function testUserPayments(userId) {
  const response = http.get(`${BASE_URL}/users/${userId}/payments`);
  
  const success = check(response, {
    'user payments status is 200 or 503': (r) => r.status === 200 || r.status === 503,
    'user payments response structure': (r) => {
      if (r.status === 503) return true; // Service unavailable is acceptable
      try {
        const data = JSON.parse(r.body);
        return data.user && data.payments;
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

function testAnalytics() {
  const response = http.get(`${BASE_URL}/analytics/users`);
  
  const success = check(response, {
    'analytics status is 200': (r) => r.status === 200,
    'analytics has required data': (r) => {
      try {
        const data = JSON.parse(r.body);
        return data.totalUsers && data.usersByDemographics;
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
  });
}