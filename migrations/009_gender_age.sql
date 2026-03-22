-- Migration 009: Add gender + age to users; update v_hosts view
-- gender: 'male' | 'female' | 'other' (nullable — existing users unaffected)
-- age:    integer 18–100 (nullable)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gender VARCHAR(10),
  ADD COLUMN IF NOT EXISTS age    INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_gender ON users(gender);

-- Recreate v_hosts view to expose gender + age from the users table.
-- Previously only exposed: name, avatar, phone, fcm_token, last_seen_at.
CREATE OR REPLACE VIEW v_hosts AS
  SELECT
    h.*,
    u.name,
    u.avatar,
    u.phone,
    u.fcm_token,
    u.last_seen_at,
    u.gender,
    u.age
  FROM hosts h
  JOIN users u ON u.id = h.user_id;
