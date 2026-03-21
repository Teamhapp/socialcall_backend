-- Migration 006: Reports & Content Moderation
-- Adds reports table and is_flagged column to hosts

-- Add is_flagged to hosts (if not exists)
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('host', 'message', 'call')),
  target_id UUID NOT NULL,
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('inappropriate', 'fake_profile', 'spam', 'harassment', 'other')),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
  admin_note TEXT,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);

-- Unique: one report per user per target
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_unique ON reports(reporter_id, target_type, target_id);
