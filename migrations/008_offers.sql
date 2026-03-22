-- Migration 008: Promotional Offers / Deals Banners
-- Run: psql -U postgres -d socialcall_db -f migrations/008_offers.sql

CREATE TABLE IF NOT EXISTS offers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title        VARCHAR(100) NOT NULL,
  subtitle     VARCHAR(200),
  bg_color_hex VARCHAR(7)   NOT NULL DEFAULT '#FF4D79',
  icon_emoji   VARCHAR(10)  NOT NULL DEFAULT '🎉',
  cta_label    VARCHAR(50)  NOT NULL DEFAULT 'Claim Now',
  promo_code   VARCHAR(50),           -- optional link to a promo_codes.code
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  starts_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offers_active  ON offers(is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at DESC);
