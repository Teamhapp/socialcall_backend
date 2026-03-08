const logger = require('../config/logger');

// ─── Global error handler (put last in app.js) ──────────────────────────────
const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    userId: req.user?.id,
  });

  // Validation errors (express-validator)
  if (err.type === 'validation') {
    return res.status(400).json({ success: false, message: 'Validation failed', errors: err.errors });
  }

  // PostgreSQL unique violation
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'Resource already exists' });
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'Invalid reference' });
  }

  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? (status < 500 ? err.message : 'Internal server error')
    : err.message;

  res.status(status).json({ success: false, message });
};

// ─── 404 handler ────────────────────────────────────────────────────────────
const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
};

// ─── Validation helper ───────────────────────────────────────────────────────
const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

module.exports = { errorHandler, notFound, validate };
