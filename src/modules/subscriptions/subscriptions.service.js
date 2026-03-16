const { query, pool } = require('../../config/database');

const SUBSCRIPTION_PRICE = 99;
const SUBSCRIPTION_DAYS  = 30;

// ── Subscribe to a host ───────────────────────────────────────────────────────
const subscribe = async (userId, hostId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check balance
    const walletRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
    const balance = parseFloat(walletRes.rows[0]?.wallet_balance || 0);
    if (balance < SUBSCRIPTION_PRICE) {
      throw Object.assign(
        new Error(`Insufficient balance. You need ₹${SUBSCRIPTION_PRICE} coins.`),
        { status: 400 }
      );
    }

    // Check host exists
    const hostRes = await client.query('SELECT id FROM hosts WHERE id = $1', [hostId]);
    if (!hostRes.rows[0]) throw Object.assign(new Error('Host not found'), { status: 404 });

    // Check existing active subscription
    const existing = await client.query(
      "SELECT id, expires_at FROM subscriptions WHERE user_id = $1 AND host_id = $2",
      [userId, hostId]
    );
    const now = new Date();
    if (existing.rows[0] && new Date(existing.rows[0].expires_at) > now) {
      throw Object.assign(new Error('You already have an active subscription to this host.'), { status: 409 });
    }

    // Deduct from wallet
    const newBalance = balance - SUBSCRIPTION_PRICE;
    await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, userId]);

    // Credit host earnings (50% = ₹49.50 → ₹50)
    const hostEarnings = Math.floor(SUBSCRIPTION_PRICE * 0.5);
    await client.query(
      'UPDATE hosts SET total_earnings = total_earnings + $1, pending_earnings = pending_earnings + $1 WHERE id = $2',
      [hostEarnings, hostId]
    );

    // Upsert subscription
    const expiresAt = new Date(now.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);
    const { rows } = await client.query(`
      INSERT INTO subscriptions (user_id, host_id, amount, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, host_id) DO UPDATE SET
        amount = EXCLUDED.amount, expires_at = EXCLUDED.expires_at, created_at = NOW()
      RETURNING *
    `, [userId, hostId, SUBSCRIPTION_PRICE, expiresAt]);

    // Log transaction
    await client.query(`
      INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description)
      VALUES ($1, 'subscription', 'completed', $2, FALSE, $3, 'Monthly subscription')
    `, [userId, SUBSCRIPTION_PRICE, newBalance]);

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ── Get subscription status ────────────────────────────────────────────────────
const getStatus = async (userId, hostId) => {
  const { rows } = await query(
    'SELECT * FROM subscriptions WHERE user_id = $1 AND host_id = $2',
    [userId, hostId]
  );
  if (!rows[0]) return { isSubscribed: false, subscription: null };
  const isActive = new Date(rows[0].expires_at) > new Date();
  return { isSubscribed: isActive, subscription: rows[0] };
};

// ── Unsubscribe (expire immediately) ─────────────────────────────────────────
const unsubscribe = async (userId, hostId) => {
  const { rows } = await query(
    "UPDATE subscriptions SET expires_at = NOW() WHERE user_id = $1 AND host_id = $2 RETURNING *",
    [userId, hostId]
  );
  if (!rows[0]) throw Object.assign(new Error('Subscription not found'), { status: 404 });
  return rows[0];
};

// ── Subscriber count for a host ────────────────────────────────────────────────
const getHostSubscriberCount = async (hostId) => {
  const { rows } = await query(
    "SELECT COUNT(*) AS count FROM subscriptions WHERE host_id = $1 AND expires_at > NOW()",
    [hostId]
  );
  return parseInt(rows[0].count, 10);
};

module.exports = { subscribe, getStatus, unsubscribe, getHostSubscriberCount };
