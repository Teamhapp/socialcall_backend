require('express-async-errors');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { errorHandler, notFound } = require('./middleware/errorHandler');
const logger = require('./config/logger');

// ─── Critical ENV validation ──────────────────────────────────────────────────
// Fail fast with clear message rather than cryptic runtime errors
const REQUIRED_ENV = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ MISSING REQUIRED ENV VARS: ${missing.join(', ')}\n`);
  console.error('Set these in Replit Secrets (padlock icon) or .env file.\n');
  process.exit(1);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRoutes          = require('./modules/auth/auth.routes');
const hostsRoutes         = require('./modules/hosts/hosts.routes');
const callsRoutes         = require('./modules/calls/calls.routes');
const chatRoutes          = require('./modules/chat/chat.routes');
const walletRoutes        = require('./modules/wallet/wallet.routes');
const streamsRoutes       = require('./modules/streams/streams.routes');
const subscriptionsRoutes = require('./modules/subscriptions/subscriptions.routes');
const adminRoutes         = require('./admin/admin.routes');

const app = express();

// ─── Trust Replit / Cloud Run reverse-proxy headers ───────────────────────────
app.set('trust proxy', 1);

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: mobile apps don't send Origin headers so '*' is safe and required.
// For web dashboards, set ALLOWED_ORIGINS in Secrets.
const corsOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : true; // true = reflect all origins (required for mobile apps)

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message) => logger.http(message.trim()) },
  }));
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 10,
  message: { success: false, message: 'Too many auth requests.' },
});

app.use('/api/', globalLimiter);
app.use('/api/auth/', authLimiter);

// ─── Static files (avatars/uploads) ──────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    res.json({
      success: true,
      status: 'healthy',
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ success: false, status: 'unhealthy', error: err.message });
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/hosts',         hostsRoutes);
app.use('/api/calls',         callsRoutes);
app.use('/api/chat',          chatRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/streams',       streamsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/admin',             adminRoutes);

// FCM token registration
app.post('/api/users/fcm-token',
  require('./middleware/auth').authenticate,
  async (req, res) => {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'fcmToken required' });
    const notifSvc = require('./modules/notifications/notification.service');
    await notifSvc.saveToken(req.user.id, fcmToken);
    res.json({ success: true });
  }
);

// User profile — GET
app.get('/api/users/profile', require('./middleware/auth').authenticate, async (req, res) => {
  const { query } = require('./config/database');
  const { rows } = await query(`
    SELECT u.*, h.id AS host_id, h.audio_rate_per_min, h.video_rate_per_min, h.rating,
           h.is_online, h.is_verified, h.total_earnings, h.pending_earnings
    FROM users u LEFT JOIN hosts h ON h.user_id = u.id
    WHERE u.id = $1
  `, [req.user.id]);
  res.json({ success: true, data: rows[0] });
});

// User profile — PATCH (update name / avatar)
app.patch('/api/users/profile', require('./middleware/auth').authenticate, async (req, res) => {
  const { query } = require('./config/database');
  const { name, avatar } = req.body;
  const fields = [];
  const values = [];
  let idx = 1;
  if (name)   { fields.push(`name   = $${idx++}`); values.push(name.trim()); }
  if (avatar) { fields.push(`avatar = $${idx++}`); values.push(avatar); }
  if (!fields.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
  values.push(req.user.id);
  const { rows } = await query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, avatar, phone, wallet_balance, is_host`,
    values
  );
  res.json({ success: true, data: rows[0] });
});

// Delete account (soft-delete: marks user inactive, clears sensitive data)
app.delete('/api/users/me', require('./middleware/auth').authenticate, async (req, res) => {
  const { withTransaction } = require('./config/database');
  await withTransaction(async (client) => {
    // Soft-delete: anonymise phone so it can be re-registered, clear FCM token
    await client.query(
      "UPDATE users SET is_active = FALSE, fcm_token = NULL, phone = CONCAT('del_', id, '_', SUBSTRING(phone, 1, 5)) WHERE id = $1 AND phone NOT LIKE 'del_%'",
      [req.user.id]
    );
  });
  res.json({ success: true, message: 'Account deleted' });
});

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
