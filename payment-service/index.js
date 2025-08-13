const express = require("express");
const axios = require("axios");
const metricsMiddleware = require("./metricsMiddleware");
const logger = require("./logger");
const morgan = require("morgan");
const client = require("./metrics").client;

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.http(msg.trim()) },
  })
);

const port = process.env.PORT || 3003;

let transactions = [];
let refunds = [];

// Middleware to log every request
app.use((req, res, next) => {
  const startTime = Date.now();

  logger.info("Incoming request", {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get("User-Agent"),
  });

  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - startTime;
    logger.logRequest(req, res, duration);
    originalEnd.apply(this, args);
  };

  next();
});

app.post("/pay", async (req, res) => {
  const { orderId, amount, userId } = req.body;

  // Validate required fields
  if (!orderId || !amount) {
    logger.warn("Payment request missing required fields", {
      route: "/pay",
      orderId: orderId || "missing",
      amount: amount || "missing",
      userId: userId || "missing",
      requestBody: req.body,
    });
    return res.status(400).send({
      error: "Missing required fields: orderId and amount are required",
    });
  }

  // Validate amount is a positive number
  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    logger.warn("Invalid payment amount", {
      route: "/pay",
      orderId,
      amount,
      numericAmount,
    });
    return res.status(400).send({
      error: "Invalid amount: must be a positive number",
    });
  }

  logger.info("Processing payment", {
    orderId,
    amount: numericAmount,
    userId,
    currency: "₹",
    route: "/pay",
  });

  try {
    // NEW: Get user information for payment processing
    let userInfo = null;
    if (userId) {
      try {
        const userResponse = await axios.get(
          `http://user-service:3001/users/${userId}`,
          {
            timeout: 3000,
          }
        );
        userInfo = userResponse.data;
        logger.info("User information retrieved for payment", {
          userId,
          userName: userInfo.name,
        });
      } catch (err) {
        logger.warn("Failed to retrieve user info for payment", {
          userId,
          error: err.message,
        });
      }
    }

    // Simulate payment processing time
    const processingStart = Date.now();

    // Simulate random payment failures (5% failure rate)
    const shouldFail = Math.random() < 0.05;
    if (shouldFail) {
      logger.warn("Simulated payment failure", {
        orderId,
        amount: numericAmount,
        userId,
        reason: "insufficient_funds",
      });
      return res.status(402).send({
        error: "Payment failed: Insufficient funds",
        orderId,
        amount: numericAmount,
      });
    }

    const transactionId = `txn_${Date.now()}_${orderId}`;
    const paymentResult = {
      status: "paid",
      orderId,
      amount: numericAmount,
      transactionId,
      processedAt: new Date().toISOString(),
      user: userInfo,
    };

    // Store transaction
    transactions.push(paymentResult);

    const processingDuration = Date.now() - processingStart;

    logger.info("Payment processed successfully", {
      orderId,
      amount: numericAmount,
      userId,
      userName: userInfo?.name,
      transactionId: paymentResult.transactionId,
      processingTime: `${processingDuration}ms`,
      route: "/pay",
    });

    res.send(paymentResult);
  } catch (err) {
    logger.logError(err, {
      route: "/pay",
      orderId,
      amount: numericAmount,
      userId,
      errorType: "payment_processing_error",
    });

    res.status(500).send({
      error: "Payment processing failed",
      orderId,
      amount: numericAmount,
    });
  }
});

// NEW: Refund endpoint
app.post("/refund", async (req, res) => {
  const { transactionId, amount, reason } = req.body;

  if (!transactionId || !amount) {
    logger.warn("Refund request missing required fields", {
      route: "/refund",
      transactionId: transactionId || "missing",
      amount: amount || "missing",
      requestBody: req.body,
    });
    return res.status(400).send({
      error: "Missing required fields: transactionId and amount are required",
    });
  }

  logger.info("Processing refund", {
    transactionId,
    amount: parseFloat(amount),
    reason: reason || "order_cancellation",
    route: "/refund",
  });

  try {
    // Find original transaction
    const originalTransaction = transactions.find(
      (t) => t.transactionId === transactionId
    );

    if (!originalTransaction) {
      logger.warn("Transaction not found for refund", {
        transactionId,
        availableTransactions: transactions.map((t) => t.transactionId),
      });
      return res.status(404).send({
        error: "Transaction not found",
      });
    }

    // Validate refund amount
    const refundAmount = parseFloat(amount);
    if (refundAmount > originalTransaction.amount) {
      logger.warn("Refund amount exceeds original transaction", {
        transactionId,
        originalAmount: originalTransaction.amount,
        refundAmount,
      });
      return res.status(400).send({
        error: "Refund amount cannot exceed original transaction amount",
      });
    }

    const refundId = `refund_${Date.now()}_${transactionId}`;
    const refund = {
      refundId,
      originalTransactionId: transactionId,
      amount: refundAmount,
      reason: reason || "order_cancellation",
      processedAt: new Date().toISOString(),
      status: "processed",
    };

    refunds.push(refund);

    logger.info("Refund processed successfully", {
      refundId,
      transactionId,
      amount: refundAmount,
      reason: refund.reason,
    });

    res.send(refund);
  } catch (err) {
    logger.logError(err, {
      route: "/refund",
      transactionId,
      amount,
      errorType: "refund_processing_error",
    });

    res.status(500).send({
      error: "Refund processing failed",
    });
  }
});

// NEW: Get payment history
app.get("/payments", (req, res) => {
  const { orderId, userId, status, limit } = req.query;

  logger.info("Retrieving payment history", {
    route: "/payments",
    totalTransactions: transactions.length,
    filters: { orderId, userId, status, limit },
  });

  let filteredTransactions = [...transactions];

  if (orderId) {
    filteredTransactions = filteredTransactions.filter(
      (t) => t.orderId == orderId
    );
  }

  if (userId) {
    filteredTransactions = filteredTransactions.filter(
      (t) => t.user?.id == userId
    );
  }

  if (status) {
    filteredTransactions = filteredTransactions.filter(
      (t) => t.status === status
    );
  }

  if (limit) {
    const limitNum = parseInt(limit);
    if (!isNaN(limitNum) && limitNum > 0) {
      filteredTransactions = filteredTransactions.slice(0, limitNum);
    }
  }

  logger.info("Payment history retrieved", {
    totalTransactions: transactions.length,
    filteredTransactions: filteredTransactions.length,
  });

  res.send({
    transactions: filteredTransactions,
    total: transactions.length,
    filtered: filteredTransactions.length,
  });
});

// NEW: Get refund history
app.get("/refunds", (req, res) => {
  const { transactionId, limit } = req.query;

  logger.info("Retrieving refund history", {
    route: "/refunds",
    totalRefunds: refunds.length,
    filters: { transactionId, limit },
  });

  let filteredRefunds = [...refunds];

  if (transactionId) {
    filteredRefunds = filteredRefunds.filter(
      (r) => r.originalTransactionId === transactionId
    );
  }

  if (limit) {
    const limitNum = parseInt(limit);
    if (!isNaN(limitNum) && limitNum > 0) {
      filteredRefunds = filteredRefunds.slice(0, limitNum);
    }
  }

  logger.info("Refund history retrieved", {
    totalRefunds: refunds.length,
    filteredRefunds: filteredRefunds.length,
  });

  res.send({
    refunds: filteredRefunds,
    total: refunds.length,
    filtered: filteredRefunds.length,
  });
});

// NEW: Payment analytics endpoint
app.get("/analytics/payments", async (req, res) => {
  logger.info("Generating payment analytics", {
    route: "/analytics/payments",
  });

  try {
    const totalRevenue = transactions.reduce((sum, t) => sum + t.amount, 0);
    const totalRefunds = refunds.reduce((sum, r) => sum + r.amount, 0);
    const netRevenue = totalRevenue - totalRefunds;

    // Get user demographics for payment analytics
    const userIds = [
      ...new Set(transactions.map((t) => t.user?.id).filter(Boolean)),
    ];
    const userPromises = userIds.map((userId) =>
      axios
        .get(`http://user-service:3001/users/${userId}/profile`, {
          timeout: 3000,
        })
        .catch((err) => {
          logger.warn("Failed to fetch user profile for payment analytics", {
            userId,
            error: err.message,
          });
          return { data: { demographics: "unknown" } };
        })
    );

    const userProfiles = await Promise.all(userPromises);

    const analytics = {
      totalTransactions: transactions.length,
      totalRefunds: refunds.length,
      totalRevenue,
      totalRefundAmount: totalRefunds,
      netRevenue,
      averageTransactionValue:
        transactions.length > 0 ? totalRevenue / transactions.length : 0,
      successRate:
        transactions.length /
        (transactions.length + Math.ceil(transactions.length * 0.05)), // Accounting for failed payments
      userDemographics: userProfiles.map(
        (p) => p.data.demographics || "unknown"
      ),
      generatedAt: new Date().toISOString(),
    };

    logger.info("Payment analytics generated successfully", {
      totalTransactions: analytics.totalTransactions,
      totalRevenue: analytics.totalRevenue,
      netRevenue: analytics.netRevenue,
    });

    res.send(analytics);
  } catch (err) {
    logger.logError(err, {
      route: "/analytics/payments",
      errorType: "analytics_generation_error",
    });

    res.status(500).send({
      error: "Failed to generate payment analytics",
    });
  }
});

// NEW: Transaction status check
app.get("/transactions/:id/status", (req, res) => {
  const transactionId = req.params.id;

  logger.info("Checking transaction status", {
    transactionId,
    route: "/transactions/:id/status",
  });

  const transaction = transactions.find(
    (t) => t.transactionId === transactionId
  );

  if (!transaction) {
    logger.warn("Transaction not found for status check", {
      transactionId,
    });
    return res.status(404).send({ error: "Transaction not found" });
  }

  const relatedRefunds = refunds.filter(
    (r) => r.originalTransactionId === transactionId
  );
  const totalRefunded = relatedRefunds.reduce((sum, r) => sum + r.amount, 0);

  logger.info("Transaction status retrieved", {
    transactionId,
    status: transaction.status,
    totalRefunded,
  });

  res.send({
    transaction,
    refunds: relatedRefunds,
    totalRefunded,
    netAmount: transaction.amount - totalRefunded,
  });
});

app.get("/metrics", async (req, res) => {
  logger.debug("Metrics endpoint accessed");

  try {
    const metrics = await client.register.metrics();
    res.set("Content-Type", client.register.contentType);
    res.send(metrics);

    logger.info("Metrics served successfully");
  } catch (error) {
    logger.logError(error, {
      endpoint: "/metrics",
      message: "Failed to retrieve metrics",
    });
    res.status(500).send({ error: "Failed to retrieve metrics" });
  }
});

const services = {
  userService: "http://user-service:3001/ready",
  paymentService: "http://order-service:3002/ready",
  orderService: "http://payment-service:3003/ready", // add more as needed
};

app.get("/health", async (req, res) => {
  const results = await Promise.allSettled(
    Object.entries(services).map(([key, url]) =>
      axios.get(url, { timeout: 3000 })
        .then(() => ({ service: key, status: "ok" }))
        .catch(err => ({
          service: key,
          status: 'down',
          error: {
            message: err.message,
            code: err.code,
            statusCode: err.response?.status
          }
        }))
    )
  );

  const safeResults = results.map(r => r.value || r.reason);

  const statusReport = Object.keys(services).reduce((acc, key, i) => {
    acc[key] = results[i].status === "fulfilled" ? "ok" : "down";
    return acc;
  }, {});

  res.status(200).send({
    status: Object.values(statusReport).every((s) => s === "ok")
      ? "ok"
      : "partial",
    status_results: safeResults,
    services: statusReport,
    deps: statusReport,
    transactionsCount: transactions.length,
    refundsCount: refunds.length,
  });
});

app.get("/ready", (req, res) => res.sendStatus(200));

// Error handling middleware
app.use((error, req, res, next) => {
  logger.logError(error, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
  });

  res.status(500).send({
    error: "Internal server error",
    requestId: req.id || "unknown",
  });
});

// Handle 404 routes
app.use((req, res) => {
  logger.warn("Route not found", {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  });

  res.status(404).send({
    error: "Route not found",
    method: req.method,
    path: req.originalUrl,
  });
});

// Graceful server startup
const server = app.listen(port, () => {
  logger.info("Payment service started successfully", {
    port,
    environment: process.env.NODE_ENV || "development",
    processId: process.pid,
    service: "payment-service",
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`, {
    service: "payment-service",
    transactionsInMemory: transactions.length,
    refundsInMemory: refunds.length,
  });

  server.close((err) => {
    if (err) {
      logger.logError(err, { context: "Graceful shutdown failed" });
      process.exit(1);
    }

    logger.info("Payment service closed successfully");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Forced shutdown due to timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.logError(error, {
    context: "Uncaught Exception",
    service: "payment-service",
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection", {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise.toString(),
    service: "payment-service",
  });
});
