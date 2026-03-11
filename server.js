require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const http = require('http');
const { Server } = require('socket.io');

const app = require('./src/app');
const { initSocket } = require('./src/socket/socket');
const { pool } = require('./src/config/database');
const { getRedisClient } = require('./src/config/redis');
const logger = require('./src/config/logger');

const PORT = parseInt(process.env.PORT) || 5000;

// ─── Create HTTP server ───────────────────────────────────────────────────────
const httpServer = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// Make io available in routes via app
app.set('io', io);

// Initialize socket handlers
initSocket(io);

// ─── Startup ──────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()');
    logger.info('✅ PostgreSQL connected');

    // Connect Redis (truly non-blocking — server starts regardless)
    getRedisClient()
      .then(() => logger.info('✅ Redis connected'))
      .catch((err) => logger.warn('⚠️  Redis unavailable — running without cache', { error: err.message }));

    httpServer.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`, {
        env: process.env.NODE_ENV,
        port: PORT,
      });
      console.log(`
╔═══════════════════════════════════════╗
║       SocialCall Backend API          ║
║                                       ║
║  HTTP  →  http://localhost:${PORT}      ║
║  WS    →  ws://localhost:${PORT}        ║
║  Health → http://localhost:${PORT}/health║
╚═══════════════════════════════════════╝
      `);
    });
  } catch (err) {
    logger.error('❌ Startup failed', { error: err.message });
    process.exit(1);
  }
};

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  httpServer.close(() => {
    logger.info('HTTP server closed');
    pool.end(() => {
      logger.info('Database pool closed');
      process.exit(0);
    });
  });
  setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

start();
