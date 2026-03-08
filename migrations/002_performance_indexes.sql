-- ═══════════════════════════════════════════════════════════════════
--  SocialCall — Performance indexes for 1000+ users
--  Run: psql -U postgres -d socialcall_db -f migrations/002_performance_indexes.sql
-- ═══════════════════════════════════════════════════════════════════

-- Composite index for main hosts query (is_active + is_online + rating)
CREATE INDEX IF NOT EXISTS idx_hosts_active_online_rating
  ON hosts(is_active, is_online DESC, rating DESC);

-- GIN trigram index for host name search (ILIKE '%search%')
CREATE INDEX IF NOT EXISTS idx_users_name_trgm
  ON users USING GIN(name gin_trgm_ops);

-- Composite index for wallet transactions listing (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON transactions(user_id, created_at DESC);

-- Composite index for messages conversation (sender+receiver ordered by time)
CREATE INDEX IF NOT EXISTS idx_messages_convo_time
  ON messages(sender_id, receiver_id, created_at DESC);

-- Partial index: only active hosts (most queries filter is_active = TRUE)
CREATE INDEX IF NOT EXISTS idx_hosts_active_only
  ON hosts(rating DESC, total_calls DESC) WHERE is_active = TRUE;

-- Index for unread message count queries
CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages(receiver_id, is_read) WHERE is_read = FALSE;
