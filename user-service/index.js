const express = require('express');
const app = express();
const port = process.env.PORT || 3001;

const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
];

// Middleware to log every request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/users/:id', (req, res) => {
  const userId = req.params.id;
  console.log(`Looking for user with ID: ${userId}`);

  const user = users.find(u => u.id == userId);

  if (!user) {
    console.warn(`User with ID ${userId} not found`);
    return res.status(404).send({ error: 'User not found' });
  }

  console.log(`User found: ${JSON.stringify(user)}`);
  res.send(user);
});

// Prometheus metrics endpoint (mocked for now)
app.get('/metrics', (req, res) => {
  console.log(`Serving metrics`);
  res.set('Content-Type', 'text/plain');
  res.send(`# HELP dummy_metric Just a dummy
# TYPE dummy_metric counter
dummy_metric{label="value"} 1`);
});

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`User service running on port ${port}`);
});
