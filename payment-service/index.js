const express = require('express');
const app = express();
app.use(express.json());
const port = process.env.PORT || 3003;

app.post('/pay', (req, res) => {
  const { orderId, amount } = req.body;
  // Simulate payment processing
  console.log(`Processing payment for order ${orderId} - ₹${amount}`);
  res.send({ status: 'paid', orderId, amount });
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`dummy_payment_metric 1`);
});

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});


app.listen(port, () => {
  console.log(`Payment service running on port ${port}`);
});
