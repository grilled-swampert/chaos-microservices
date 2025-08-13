import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const res = http.get('http://microservices.local/users/health'); 
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
