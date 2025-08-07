const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
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

app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`dummy_order_metric 1`);
});

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});


app.listen(port, () => {
  console.log(`Order service running on port ${port}`);
});
