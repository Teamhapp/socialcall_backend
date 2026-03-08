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

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRoutes   = require('./modules/auth/auth.routes');
const hostsRoutes  = require('./modules/hosts/hosts.routes');
const callsRoutes  = require('./modules/calls/calls.routes');
const chatRoutes   = require('./modules/chat/chat.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');

const app = express();

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
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
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/hosts',  hostsRoutes);
app.use('/api/calls',  callsRoutes);
app.use('/api/chat',   chatRoutes);
app.use('/api/wallet', walletRoutes);

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

// User profile
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

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
