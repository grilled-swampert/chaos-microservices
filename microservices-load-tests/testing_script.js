import http from 'k6/http';
import { check } from 'k6';

export default function () {
  // List of services to check
  const services = [
    'http://microservices.local/users/health',
    'http://microservices.local/orders/health',
    'http://microservices.local/payment/health'
  ];

  services.forEach(url => {
    const res = http.get(url, { timeout: '5s' });

    check(res, {
      [`${url} reachable`]: (r) => r.status === 200
    });

    // Optional: log response body
    console.log(`${url} response: ${res.body}`);
  });
}
