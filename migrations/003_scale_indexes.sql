-- ═══════════════════════════════════════════════════════════════════
--  SocialCall — Additional indexes for 10 000+ DAU scale
--  Run: psql -U postgres -d socialcall_db -f migrations/003_scale_indexes.sql
-- ═══════════════════════════════════════════════════════════════════

-- Composite index: call history per user ordered by time (covers most call-history queries)
CREATE INDEX IF NOT EXISTS idx_calls_user_created
  ON calls(user_id, created_at DESC);

-- Composite index: host call history ordered by time
CREATE INDEX IF NOT EXISTS idx_calls_host_created
  ON calls(host_id, created_at DESC);

-- Partial index: only active (ringing/connected) calls — tiny, very fast for disconnect cleanup
CREATE INDEX IF NOT EXISTS idx_calls_active
  ON calls(status, user_id) WHERE status IN ('ringing', 'connected');

-- Admin/analytics: revenue queries filter by status + date range
CREATE INDEX IF NOT EXISTS idx_calls_status_created
  ON calls(status, created_at DESC);

-- Reviews by reviewer (user_id) — missing from initial schema
CREATE INDEX IF NOT EXISTS idx_reviews_user_id
  ON reviews(user_id);

-- Composite: reviews per host ordered by time (for paginated host review listing)
CREATE INDEX IF NOT EXISTS idx_reviews_host_created
  ON reviews(host_id, created_at DESC);

-- Payout admin queries filter by status then sort by requested_at
CREATE INDEX IF NOT EXISTS idx_payouts_status_requested
  ON payouts(status, requested_at DESC);

-- Transactions by reference_id (look up txn by call_id or Razorpay payment_id)
CREATE INDEX IF NOT EXISTS idx_transactions_reference
  ON transactions(reference_id) WHERE reference_id IS NOT NULL;

-- Composite: transactions per user filtered by type (e.g. recharge history)
CREATE INDEX IF NOT EXISTS idx_transactions_user_type
  ON transactions(user_id, type, created_at DESC);

-- Wallet orders that are still open (pending expiry cleanup queries)
CREATE INDEX IF NOT EXISTS idx_wallet_orders_status
  ON wallet_orders(status, expires_at) WHERE status = 'created';
