import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const res = http.get('http://localhost:58179/health'); 
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
