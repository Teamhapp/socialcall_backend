-- Migration 007: Voice Messages in Chat
-- Adds voice_url and voice_duration_seconds to messages table

ALTER TABLE messages ADD COLUMN IF NOT EXISTS voice_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS voice_duration_seconds INTEGER;
