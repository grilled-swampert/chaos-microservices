const express = require('express');
const axios = require('axios');

const app = express();
const metricsMiddleware = require('./metricsMiddleware');
const client = require('./metrics').client;

app.use(express.json());
app.use(metricsMiddleware);

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

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/health', async (req, res) => {
  try {
    await axios.get('http://user-service:3001/health', { timeout: 1000 });
    return res.send({ status: 'ok', deps: { userService: 'ok' }});
  } catch (e) {
    return res.status(503).send({ status: 'degraded', deps: { userService: 'down' }});
  }
});


app.listen(port, () => {
  console.log(`User service running on port ${port}`);
});
