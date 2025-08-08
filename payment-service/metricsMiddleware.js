// metricsMiddleware.js
const { httpRequestCounter, httpRequestDurationMs, errorCounter } = require('./metrics');

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  // get route label: fallback to path
  const route = req.route ? req.route.path : req.path;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const code = res.statusCode;
    httpRequestCounter.inc({ method: req.method, route, code });
    httpRequestDurationMs.observe({ method: req.method, route, code }, duration);
    if (code >= 400) errorCounter.inc({ method: req.method, route, code });
  });

  next();
}

module.exports = metricsMiddleware;
