const express = require('express');
const axios = require('axios');
const metricsMiddleware = require('./metricsMiddleware');
const client = require('./metrics').client;

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

const port = process.env.PORT || 3002;

let orders = [];

app.post('/orders', async (req, res) => {
  const { userId, product } = req.body;
  try {
    const user = await axios.get(`http://user-service:3001/users/${userId}`);
    const order = { id: orders.length + 1, user: user.data, product };
    orders.push(order);
    res.send(order);
  } catch (err) {
    res.status(400).send({ error: 'User service error' });
  }
});

app.get('/orders', (req, res) => {
  res.send(orders);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/health', async (req, res) => {
  try {
    await axios.get('http://order-service:3002/health', { timeout: 1000 });
    return res.send({ status: 'ok', deps: { orderService: 'ok' }});
  } catch (e) {
    return res.status(503).send({ status: 'degraded', deps: { orderService: 'down' }});
  }
});



app.listen(port, () => {
  console.log(`Order service running on port ${port}`);
});
