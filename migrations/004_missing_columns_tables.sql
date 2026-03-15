-- ═══════════════════════════════════════════════════════════════════
--  SocialCall — Missing columns & tables discovered in code audit
--  Run: psql -U postgres -d socialcall_db -f migrations/004_missing_columns_tables.sql
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. password_hash on users ───────────────────────────────────────
-- auth.service.js uses this for optional password login alongside OTP.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- ─── 2. kyc_status on hosts ──────────────────────────────────────────
-- hosts.routes.js reads/writes this to track KYC state machine.
ALTER TABLE hosts
  ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'not_submitted'
    CHECK (kyc_status IN ('not_submitted','pending','approved','rejected'));

-- ─── 3. kyc_documents table ──────────────────────────────────────────
-- Stores host identity documents for KYC verification flow.
CREATE TABLE IF NOT EXISTS kyc_documents (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  host_id        UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  document_type  VARCHAR(50) NOT NULL,          -- e.g. 'aadhaar', 'pan', 'passport'
  front_url      TEXT,
  back_url       TEXT,
  selfie_url     TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  rejection_note TEXT,
  submitted_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at    TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_kyc_host_id ON kyc_documents(host_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status  ON kyc_documents(status);

-- ─── 4. promo_credit enum value ──────────────────────────────────────
-- wallet.service.js inserts type='promo_credit' which is not in the enum.
ALTER TYPE txn_type ADD VALUE IF NOT EXISTS 'promo_credit';

-- ─── 5. promo_codes table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(50) UNIQUE NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,           -- credit amount in rupees
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at  TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code   ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active, expires_at);

-- ─── 6. promo_redemptions table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code_id    UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(code_id, user_id)                            -- one redemption per user per code
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions(code_id);
