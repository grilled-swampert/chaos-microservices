// metrics.js
const client = require('prom-client');

client.collectDefaultMetrics({ timeout: 5000 }); // default Node metrics

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'code'],
});

const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'code'],
  buckets: [50, 100, 200, 300, 500, 1000, 2000, 5000],
});

const errorCounter = new client.Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP errors',
  labelNames: ['method', 'route', 'code'],
});

module.exports = {
  client,
  httpRequestCounter,
  httpRequestDurationMs,
  errorCounter,
};
