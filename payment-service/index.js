const express = require('express');
const axios = require('axios');

const metricsMiddleware = require('./metricsMiddleware');
const client = require('./metrics').client;
const app = express();
app.use(express.json());
app.use(metricsMiddleware);
const port = process.env.PORT || 3003;

app.post('/pay', (req, res) => {
  const { orderId, amount } = req.body;
  console.log(`Processing payment for order ${orderId} - ₹${amount}`);
  res.send({ status: 'paid', orderId, amount });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/health', async (req, res) => {
  try {
    await axios.get('http://payment-service:3003/health', { timeout: 1000 });
    return res.send({ status: 'ok', deps: { orderService: 'ok' }});
  } catch (e) {
    return res.status(503).send({ status: 'degraded', deps: { orderService: 'down' }});
  }
});

app.listen(port, () => {
  console.log(`Payment service running on port ${port}`);
});
