-- ═══════════════════════════════════════════════════════════════════
--  SocialCall Platform — PostgreSQL Schema
--  Run: psql -U postgres -d socialcall_db -f migrations/001_initial_schema.sql
-- ═══════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for fuzzy search on names

-- ─── USERS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(100) NOT NULL DEFAULT 'User',
  avatar          TEXT,
  wallet_balance  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_host         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  fcm_token       TEXT,                          -- Firebase push token
  last_seen_at    TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_is_host ON users(is_host);

-- ─── REFRESH TOKENS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);

-- ─── HOSTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hosts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bio                 TEXT DEFAULT '',
  languages           TEXT[] NOT NULL DEFAULT '{}',
  tags                TEXT[] NOT NULL DEFAULT '{}',  -- e.g. ['music','travel']
  audio_rate_per_min  DECIMAL(8,2) NOT NULL DEFAULT 15.00,
  video_rate_per_min  DECIMAL(8,2) NOT NULL DEFAULT 40.00,
  rating              DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  total_reviews       INTEGER NOT NULL DEFAULT 0,
  total_calls         INTEGER NOT NULL DEFAULT 0,
  total_earnings      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pending_earnings    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_online           BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  followers_count     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_hosts_user_id ON hosts(user_id);
CREATE INDEX idx_hosts_is_online ON hosts(is_online);
CREATE INDEX idx_hosts_rating ON hosts(rating DESC);
CREATE INDEX idx_hosts_languages ON hosts USING GIN(languages);
CREATE INDEX idx_hosts_tags ON hosts USING GIN(tags);

-- ─── FOLLOWERS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS followers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id     UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, host_id)
);

CREATE INDEX idx_followers_user ON followers(user_id);
CREATE INDEX idx_followers_host ON followers(host_id);

-- ─── CALLS ──────────────────────────────────────────────────────────
CREATE TYPE call_type AS ENUM ('audio', 'video');
CREATE TYPE call_status AS ENUM ('initiated','ringing','connected','ended','missed','failed');

CREATE TABLE IF NOT EXISTS calls (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id),
  host_id          UUID NOT NULL REFERENCES hosts(id),
  call_type        call_type NOT NULL DEFAULT 'audio',
  status           call_status NOT NULL DEFAULT 'initiated',
  channel_name     VARCHAR(100) UNIQUE NOT NULL, -- Agora channel
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  rate_per_min     DECIMAL(8,2) NOT NULL,
  amount_charged   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  host_earnings    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  started_at       TIMESTAMP WITH TIME ZONE,
  ended_at         TIMESTAMP WITH TIME ZONE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_calls_user_id ON calls(user_id);
CREATE INDEX idx_calls_host_id ON calls(host_id);
CREATE INDEX idx_calls_status ON calls(status);
CREATE INDEX idx_calls_created_at ON calls(created_at DESC);

-- ─── MESSAGES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id    UUID NOT NULL REFERENCES users(id),
  receiver_id  UUID NOT NULL REFERENCES users(id),
  content      TEXT NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text', -- text, gift, image
  gift_id      VARCHAR(50),                         -- if message_type = gift
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_receiver ON messages(receiver_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
-- Conversation lookup: find messages between two users efficiently
CREATE INDEX idx_messages_conversation ON messages(
  LEAST(sender_id::text, receiver_id::text),
  GREATEST(sender_id::text, receiver_id::text),
  created_at DESC
);

-- ─── GIFTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gifts (
  id          VARCHAR(50) PRIMARY KEY,   -- e.g. 'rose', 'diamond'
  name        VARCHAR(100) NOT NULL,
  emoji       VARCHAR(10) NOT NULL,
  price       DECIMAL(8,2) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO gifts (id, name, emoji, price) VALUES
  ('rose',    'Rose',    '🌹', 10.00),
  ('heart',   'Heart',   '❤️', 20.00),
  ('cake',    'Cake',    '🎂', 50.00),
  ('music',   'Music',   '🎵', 30.00),
  ('trophy',  'Trophy',  '🏆', 200.00),
  ('diamond', 'Diamond', '💎', 500.00)
ON CONFLICT (id) DO NOTHING;

-- ─── REVIEWS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id     UUID UNIQUE NOT NULL REFERENCES calls(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  host_id     UUID NOT NULL REFERENCES hosts(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reviews_host_id ON reviews(host_id);

-- ─── TRANSACTIONS ────────────────────────────────────────────────────
CREATE TYPE txn_type AS ENUM ('recharge','call_charge','gift_sent','gift_received','host_earning','payout','refund');
CREATE TYPE txn_status AS ENUM ('pending','completed','failed','refunded');

CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            txn_type NOT NULL,
  status          txn_status NOT NULL DEFAULT 'completed',
  amount          DECIMAL(12,2) NOT NULL,
  is_credit       BOOLEAN NOT NULL,
  balance_after   DECIMAL(12,2) NOT NULL,
  description     TEXT,
  reference_id    VARCHAR(200),             -- Razorpay payment ID / call ID
  razorpay_order_id    VARCHAR(200),
  razorpay_payment_id  VARCHAR(200),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_razorpay ON transactions(razorpay_payment_id);

-- ─── WALLET ORDERS ──────────────────────────────────────────────────
-- Stores Razorpay orders before payment confirmation
CREATE TABLE IF NOT EXISTS wallet_orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id),
  razorpay_order_id VARCHAR(200) UNIQUE NOT NULL,
  amount            DECIMAL(12,2) NOT NULL,
  currency          VARCHAR(10) NOT NULL DEFAULT 'INR',
  status            VARCHAR(20) NOT NULL DEFAULT 'created',  -- created/paid/failed
  expires_at        TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_wallet_orders_user ON wallet_orders(user_id);
CREATE INDEX idx_wallet_orders_razorpay ON wallet_orders(razorpay_order_id);

-- ─── PAYOUTS ────────────────────────────────────────────────────────
CREATE TYPE payout_status AS ENUM ('pending','processing','completed','failed');

CREATE TABLE IF NOT EXISTS payouts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id       UUID NOT NULL REFERENCES hosts(id),
  amount        DECIMAL(12,2) NOT NULL,
  status        payout_status NOT NULL DEFAULT 'pending',
  upi_id        VARCHAR(200),
  bank_account  VARCHAR(200),
  reference_id  VARCHAR(200),
  notes         TEXT,
  requested_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at  TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_payouts_host ON payouts(host_id);

-- ─── Auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_hosts_updated_at
  BEFORE UPDATE ON hosts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── View: host with user info (used in most queries) ─────────────────
CREATE OR REPLACE VIEW v_hosts AS
  SELECT
    h.*,
    u.name,
    u.avatar,
    u.phone,
    u.fcm_token,
    u.last_seen_at
  FROM hosts h
  JOIN users u ON u.id = h.user_id;
