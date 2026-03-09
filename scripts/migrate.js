// scripts/migrate.js — Run once to create all database tables
// Usage: node scripts/migrate.js

require('dotenv').config();
const { pool } = require('../src/config/database');

const migrate = async () => {
  const client = await pool.connect();
  console.log('🔄 Running migrations...');

  try {
    await client.query('BEGIN');

    // ── Users ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              BIGSERIAL PRIMARY KEY,
        phone           VARCHAR(20) UNIQUE NOT NULL,
        name            VARCHAR(100) NOT NULL,
        avatar          TEXT,
        wallet_balance  DECIMAL(12,2) NOT NULL DEFAULT 0,
        is_host         BOOLEAN NOT NULL DEFAULT FALSE,
        fcm_token       TEXT,
        last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✅ users');

    // ── Hosts ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS hosts (
        id                  BIGSERIAL PRIMARY KEY,
        user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bio                 TEXT DEFAULT '',
        languages           TEXT[] DEFAULT '{}',
        tags                TEXT[] DEFAULT '{}',
        audio_rate_per_min  DECIMAL(8,2) NOT NULL DEFAULT 15,
        video_rate_per_min  DECIMAL(8,2) NOT NULL DEFAULT 40,
        rating              DECIMAL(3,2) NOT NULL DEFAULT 0,
        total_reviews       INT NOT NULL DEFAULT 0,
        total_calls         INT NOT NULL DEFAULT 0,
        is_online           BOOLEAN NOT NULL DEFAULT FALSE,
        is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
        is_active           BOOLEAN NOT NULL DEFAULT TRUE,
        followers_count     INT NOT NULL DEFAULT 0,
        total_earnings      DECIMAL(12,2) NOT NULL DEFAULT 0,
        pending_earnings    DECIMAL(12,2) NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `);
    console.log('  ✅ hosts');

    // ── Refresh Tokens ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token       TEXT UNIQUE NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);`);
    console.log('  ✅ refresh_tokens');

    // ── Calls ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id               BIGSERIAL PRIMARY KEY,
        user_id          BIGINT NOT NULL REFERENCES users(id),
        host_id          BIGINT NOT NULL REFERENCES hosts(id),
        call_type        VARCHAR(10) NOT NULL DEFAULT 'audio',
        status           VARCHAR(20) NOT NULL DEFAULT 'ringing',
        channel_name     VARCHAR(100) NOT NULL,
        rate_per_min     DECIMAL(8,2) NOT NULL DEFAULT 0,
        started_at       TIMESTAMPTZ,
        ended_at         TIMESTAMPTZ,
        duration_seconds INT DEFAULT 0,
        amount_charged   DECIMAL(10,2) DEFAULT 0,
        host_earnings    DECIMAL(10,2) DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calls_host ON calls(host_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);`);
    console.log('  ✅ calls');

    // ── Gifts ────────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS gifts (
        id         BIGSERIAL PRIMARY KEY,
        name       VARCHAR(50) NOT NULL,
        emoji      VARCHAR(10) NOT NULL,
        price      DECIMAL(8,2) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✅ gifts');

    // ── Messages ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id            BIGSERIAL PRIMARY KEY,
        sender_id     BIGINT NOT NULL REFERENCES users(id),
        receiver_id   BIGINT NOT NULL REFERENCES users(id),
        content       TEXT NOT NULL,
        message_type  VARCHAR(20) NOT NULL DEFAULT 'text',
        gift_id       BIGINT REFERENCES gifts(id),
        is_read       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);`);
    console.log('  ✅ messages');

    // ── Reviews ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id         BIGSERIAL PRIMARY KEY,
        call_id    BIGINT UNIQUE NOT NULL REFERENCES calls(id),
        user_id    BIGINT NOT NULL REFERENCES users(id),
        host_id    BIGINT NOT NULL REFERENCES hosts(id),
        rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_host ON reviews(host_id);`);
    console.log('  ✅ reviews');

    // ── Transactions ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id                   BIGSERIAL PRIMARY KEY,
        user_id              BIGINT NOT NULL REFERENCES users(id),
        type                 VARCHAR(30) NOT NULL,
        status               VARCHAR(20) NOT NULL DEFAULT 'completed',
        amount               DECIMAL(10,2) NOT NULL,
        is_credit            BOOLEAN NOT NULL,
        balance_after        DECIMAL(12,2) NOT NULL DEFAULT 0,
        description          TEXT,
        reference_id         TEXT,
        razorpay_order_id    TEXT,
        razorpay_payment_id  TEXT,
        created_at           TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);`);
    console.log('  ✅ transactions');

    // ── Wallet Orders ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_orders (
        id                  BIGSERIAL PRIMARY KEY,
        user_id             BIGINT NOT NULL REFERENCES users(id),
        razorpay_order_id   TEXT UNIQUE NOT NULL,
        amount              DECIMAL(10,2) NOT NULL,
        status              VARCHAR(20) NOT NULL DEFAULT 'created',
        expires_at          TIMESTAMPTZ NOT NULL,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✅ wallet_orders');

    // ── Followers ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS followers (
        id         BIGSERIAL PRIMARY KEY,
        user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id    BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, host_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_followers_host ON followers(host_id);`);
    console.log('  ✅ followers');

    await client.query('COMMIT');
    console.log('\n✅ All migrations completed successfully!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
