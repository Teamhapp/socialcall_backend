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
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        fcm_token       TEXT,
        password_hash   TEXT,
        last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Add columns for existing databases (safe no-op if already present)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
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
        id         INTEGER PRIMARY KEY,
        name       VARCHAR(50) NOT NULL,
        emoji      VARCHAR(10) NOT NULL,
        price      DECIMAL(8,2) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Seed default gifts (safe no-op if already present)
    await client.query(`
      INSERT INTO gifts (id, name, emoji, price) VALUES
        (1, 'Rose',    '🌹',  10.00),
        (2, 'Heart',   '❤️',  20.00),
        (3, 'Cake',    '🎂',  50.00),
        (4, 'Music',   '🎵',  30.00),
        (5, 'Trophy',  '🏆', 200.00),
        (6, 'Diamond', '💎', 500.00)
      ON CONFLICT (id) DO NOTHING;
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

    // ── Payouts ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS payouts (
        id            BIGSERIAL PRIMARY KEY,
        host_id       BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        amount        DECIMAL(12,2) NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'pending',
        upi_id        VARCHAR(200),
        bank_account  VARCHAR(200),
        reference_id  VARCHAR(200),
        notes         TEXT,
        requested_at  TIMESTAMPTZ DEFAULT NOW(),
        processed_at  TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payouts_host ON payouts(host_id);`);
    console.log('  ✅ payouts');

    // ── Host promotion columns (safe no-op if already present) ───────────────
    await client.query(`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS is_promoted    BOOLEAN NOT NULL DEFAULT FALSE;`);
    await client.query(`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMPTZ;`);
    console.log('  ✅ hosts (is_promoted)');

    // ── Promo Codes ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id          BIGSERIAL PRIMARY KEY,
        code        VARCHAR(50) UNIQUE NOT NULL,
        amount      DECIMAL(10,2) NOT NULL,
        max_uses    INT NOT NULL DEFAULT 1,
        used_count  INT NOT NULL DEFAULT 0,
        expires_at  TIMESTAMPTZ,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('  ✅ promo_codes');

    // ── Promo Redemptions ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id          BIGSERIAL PRIMARY KEY,
        code_id     BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redeemed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code_id, user_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id);`);
    console.log('  ✅ promo_redemptions');

    // ── KYC – host identity verification ─────────────────────────────────────
    // Add kyc_status column to hosts (safe no-op if already present)
    await client.query(`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'not_submitted';`);
    console.log('  ✅ hosts (kyc_status)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id                BIGSERIAL PRIMARY KEY,
        host_id           BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        document_type     VARCHAR(30) NOT NULL DEFAULT 'aadhaar',
        front_url         TEXT NOT NULL,
        back_url          TEXT,
        selfie_url        TEXT,
        status            VARCHAR(20) NOT NULL DEFAULT 'pending',
        rejection_reason  TEXT,
        submitted_at      TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at       TIMESTAMPTZ,
        reviewed_by       TEXT DEFAULT 'admin',
        UNIQUE(host_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_documents(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kyc_host ON kyc_documents(host_id);`);
    console.log('  ✅ kyc_documents');

    // ── Fix payouts.status ENUM → VARCHAR (safe no-op if already VARCHAR) ─────
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payouts' AND column_name = 'status'
            AND data_type = 'USER-DEFINED'
        ) THEN
          ALTER TABLE payouts ALTER COLUMN status TYPE VARCHAR(20) USING status::TEXT;
          DROP TYPE IF EXISTS payout_status CASCADE;
        END IF;
      END $$;
    `);
    console.log('  ✅ payouts (status VARCHAR fix)');

    // ── Referral system ───────────────────────────────────────────────────────
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(10) UNIQUE;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(id);`);
    // Seed referral codes for existing users who don't have one
    await client.query(`
      UPDATE users SET referral_code = UPPER(SUBSTRING(MD5(id::TEXT || 'sc') FROM 1 FOR 8))
      WHERE referral_code IS NULL;
    `);
    console.log('  ✅ users (referral_code, referred_by)');

    // ── Live Streams ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_streams (
        id            BIGSERIAL PRIMARY KEY,
        host_id       BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        room_name     VARCHAR(100) UNIQUE NOT NULL,
        title         VARCHAR(200),
        viewer_count  INT NOT NULL DEFAULT 0,
        gift_count    INT NOT NULL DEFAULT 0,
        status        VARCHAR(20) NOT NULL DEFAULT 'live',
        started_at    TIMESTAMPTZ DEFAULT NOW(),
        ended_at      TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_streams_status ON live_streams(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_streams_host ON live_streams(host_id);`);
    console.log('  ✅ live_streams');

    // ── Subscriptions ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id     BIGINT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        amount      DECIMAL(10,2) NOT NULL DEFAULT 99,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, host_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_host ON subscriptions(host_id);`);
    console.log('  ✅ subscriptions');

    // ── Indexes for performance ───────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hosts_is_online ON hosts(is_online);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hosts_rating ON hosts(rating DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hosts_is_promoted ON hosts(is_promoted);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);`);
    console.log('  ✅ indexes');

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
