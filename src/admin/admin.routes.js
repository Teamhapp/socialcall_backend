// src/admin/admin.routes.js — Admin panel API + SPA serving
// Access: GET /admin  (HTML panel)
// API:    POST /admin/api/login, GET /admin/api/*  (JWT-protected)

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const path = require('path');
const { query, withTransaction } = require('../config/database');
const logger = require('../config/logger');
const notifService = require('../modules/notifications/notification.service');

// ── Admin JWT middleware ───────────────────────────────────────────────────────
const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const token = auth.slice(7);
  try {
    const secret = process.env.ADMIN_SECRET || 'admin_secret_change_me';
    req.admin = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ── Serve SPA ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel.html'));
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  const secret = process.env.ADMIN_SECRET || 'admin_secret_change_me';
  if (!password || password !== secret) {
    logger.warn('Admin login failed attempt');
    return res.status(401).json({ success: false, message: 'Invalid password' });
  }
  const token = jwt.sign({ role: 'admin', iat: Date.now() }, secret, { expiresIn: '24h' });
  logger.info('Admin logged in');
  res.json({ success: true, token });
});

// ── Dashboard Stats ───────────────────────────────────────────────────────────
router.get('/api/stats', adminAuth, async (req, res) => {
  // Run core stats + promo count separately to gracefully handle pre-migration state
  const [coreRes, promoRes, kycRes] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*)                        FROM users  WHERE is_active = TRUE)                                    AS total_users,
        (SELECT COUNT(*)                        FROM hosts  WHERE is_online = TRUE)                                    AS hosts_online,
        (SELECT COUNT(*)                        FROM hosts  WHERE is_active = TRUE)                                    AS total_hosts,
        (SELECT COUNT(*)                        FROM calls  WHERE DATE(created_at) = CURRENT_DATE)                    AS calls_today,
        (SELECT COALESCE(SUM(amount_charged),0) FROM calls  WHERE DATE(created_at) = CURRENT_DATE AND status='ended') AS revenue_today,
        (SELECT COUNT(*)                        FROM calls  WHERE status = 'ended')                                    AS total_calls,
        (SELECT COALESCE(SUM(amount_charged),0) FROM calls  WHERE status = 'ended')                                    AS total_revenue,
        (SELECT COUNT(*)                        FROM payouts WHERE status = 'pending')                                AS pending_payouts,
        (SELECT COUNT(*)                        FROM hosts  WHERE is_verified = FALSE AND is_active = TRUE)           AS unverified_hosts
    `),
    query(`SELECT COUNT(*) AS active_promos FROM promo_codes WHERE is_active = TRUE`).catch(() => ({ rows: [{ active_promos: 0 }] })),
    query(`SELECT COUNT(*) AS pending_kyc FROM kyc_documents WHERE status = 'pending'`).catch(() => ({ rows: [{ pending_kyc: 0 }] })),
  ]);
  res.json({ success: true, data: { ...coreRes.rows[0], active_promos: promoRes.rows[0].active_promos, pending_kyc: kycRes.rows[0].pending_kyc } });
});

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/api/users', adminAuth, async (req, res) => {
  const { page = 1, limit = 20, search, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  if (status === 'active')  conditions.push('u.is_active = TRUE');
  if (status === 'blocked') conditions.push('u.is_active = FALSE');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const listParams  = [...params, Number(limit), offset];
  const countParams = [...params];

  const { rows } = await query(`
    SELECT u.id, u.name, u.phone, u.wallet_balance, u.is_host,
           u.is_active, u.created_at, u.last_seen_at,
           COUNT(c.id)::int AS total_calls,
           COALESCE(SUM(c.amount_charged),0) AS total_spent
    FROM users u
    LEFT JOIN calls c ON c.user_id = u.id
    ${where}
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
  `, listParams);

  const countRes = await query(`SELECT COUNT(*) FROM users u ${where}`, countParams);
  res.json({ success: true, data: rows, total: parseInt(countRes.rows[0].count) });
});

router.post('/api/users/:id/wallet', adminAuth, async (req, res) => {
  const { amount, note } = req.body || {};
  const numAmount = parseFloat(amount);
  if (!amount || isNaN(numAmount)) {
    return res.status(400).json({ success: false, message: 'Valid amount required' });
  }

  await withTransaction(async (client) => {
    const userRes = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance, name',
      [numAmount, req.params.id]
    );
    if (!userRes.rows[0]) throw { status: 404, message: 'User not found' };

    const newBalance = parseFloat(userRes.rows[0].wallet_balance);
    await client.query(`
      INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description)
      VALUES ($1, 'admin_bonus', 'completed', $2, $3, $4, $5)
    `, [req.params.id, Math.abs(numAmount), numAmount > 0, newBalance, note || 'Admin wallet adjustment']);

    logger.info('Admin wallet adjustment', { userId: req.params.id, amount: numAmount });
  });

  res.json({ success: true, message: `Wallet adjusted by ₹${numAmount}` });
});

router.patch('/api/users/:id/status', adminAuth, async (req, res) => {
  const { is_active } = req.body || {};
  await query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active, req.params.id]);
  logger.info('Admin user status change', { userId: req.params.id, is_active });
  res.json({ success: true, message: is_active ? 'User unblocked' : 'User blocked' });
});

// ── Hosts ─────────────────────────────────────────────────────────────────────
router.get('/api/hosts', adminAuth, async (req, res) => {
  const { page = 1, limit = 20, search, verified } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  if (verified === 'true')  conditions.push('h.is_verified = TRUE');
  if (verified === 'false') conditions.push('h.is_verified = FALSE');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const listParams = [...params, Number(limit), offset];

  // Try full query with promoted columns; fall back gracefully if migration not run yet
  let rows;
  try {
    ({ rows } = await query(`
      SELECT h.id, h.user_id, u.name, u.phone, u.avatar,
             h.audio_rate_per_min, h.video_rate_per_min, h.rating,
             h.total_calls, h.total_earnings, h.pending_earnings,
             h.is_online, h.is_verified, h.is_active, h.is_promoted,
             h.promoted_until, h.created_at
      FROM hosts h
      JOIN users u ON u.id = h.user_id
      ${where}
      ORDER BY h.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `, listParams));
  } catch {
    // Pre-migration fallback: is_promoted columns not yet added
    ({ rows } = await query(`
      SELECT h.id, h.user_id, u.name, u.phone, u.avatar,
             h.audio_rate_per_min, h.video_rate_per_min, h.rating,
             h.total_calls, h.total_earnings, h.pending_earnings,
             h.is_online, h.is_verified, h.is_active,
             FALSE AS is_promoted, NULL AS promoted_until, h.created_at
      FROM hosts h
      JOIN users u ON u.id = h.user_id
      ${where}
      ORDER BY h.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `, listParams));
  }

  res.json({ success: true, data: rows });
});

router.patch('/api/hosts/:id/verify', adminAuth, async (req, res) => {
  const { is_verified } = req.body || {};
  await query('UPDATE hosts SET is_verified = $1 WHERE id = $2', [is_verified, req.params.id]);
  logger.info('Admin host verify change', { hostId: req.params.id, is_verified });
  res.json({ success: true, message: is_verified ? 'Host verified ✓' : 'Host unverified' });
});

router.patch('/api/hosts/:id/promote', adminAuth, async (req, res) => {
  const { days = 30 } = req.body || {};
  const promotedUntil = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
  try {
    await query(
      'UPDATE hosts SET is_promoted = TRUE, promoted_until = $1 WHERE id = $2',
      [promotedUntil, req.params.id]
    );
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.status(503).json({ success: false, message: 'Run `node scripts/migrate.js` first to enable host promotions' });
    }
    throw err;
  }
  logger.info('Admin host promoted', { hostId: req.params.id, days });
  res.json({ success: true, message: `Host promoted for ${days} days` });
});

router.patch('/api/hosts/:id/demote', adminAuth, async (req, res) => {
  await query('UPDATE hosts SET is_promoted = FALSE, promoted_until = NULL WHERE id = $1', [req.params.id]);
  res.json({ success: true, message: 'Host promotion removed' });
});

// ── Calls ─────────────────────────────────────────────────────────────────────
router.get('/api/calls', adminAuth, async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const conditions = [];
  const params = [];

  if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit), offset);

  const { rows } = await query(`
    SELECT c.id, c.call_type, c.status, c.duration_seconds,
           c.amount_charged, c.host_earnings, c.created_at,
           u.name AS user_name, u.phone AS user_phone,
           hu.name AS host_name
    FROM calls c
    JOIN users u  ON u.id  = c.user_id
    JOIN hosts h  ON h.id  = c.host_id
    JOIN users hu ON hu.id = h.user_id
    ${where}
    ORDER BY c.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  res.json({ success: true, data: rows });
});

// ── Payouts ───────────────────────────────────────────────────────────────────
router.get('/api/payouts', adminAuth, async (req, res) => {
  const { status = 'pending' } = req.query;
  const { rows } = await query(`
    SELECT p.*, u.name AS host_name, u.phone AS host_phone
    FROM payouts p
    JOIN hosts h ON h.id = p.host_id
    JOIN users u ON u.id = h.user_id
    WHERE p.status = $1
    ORDER BY p.requested_at DESC
    LIMIT 100
  `, [status]);
  res.json({ success: true, data: rows });
});

router.patch('/api/payouts/:id', adminAuth, async (req, res) => {
  const { status, reference_id, notes } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
  }

  await withTransaction(async (client) => {
    const payoutRes = await client.query('SELECT * FROM payouts WHERE id = $1 AND status = $2', [req.params.id, 'pending']);
    if (!payoutRes.rows[0]) throw { status: 404, message: 'Payout not found or already processed' };

    const payout = payoutRes.rows[0];
    await client.query(
      'UPDATE payouts SET status=$1, reference_id=$2, notes=$3, processed_at=NOW() WHERE id=$4',
      [status, reference_id || null, notes || null, req.params.id]
    );

    if (status === 'approved') {
      // Deduct from pending_earnings since it's now paid
      await client.query(
        'UPDATE hosts SET pending_earnings = GREATEST(0, pending_earnings - $1) WHERE id = $2',
        [payout.amount, payout.host_id]
      );
    }

    logger.info('Admin payout processed', { payoutId: req.params.id, status, amount: payout.amount });
  });

  res.json({ success: true, message: `Payout ${status}` });
});

// ── Promo Codes ───────────────────────────────────────────────────────────────
router.get('/api/promo-codes', adminAuth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, data: rows });
  } catch {
    // Table doesn't exist yet — migration not run
    res.json({ success: true, data: [], _note: 'Run node scripts/migrate.js to enable promo codes' });
  }
});

router.post('/api/promo-codes', adminAuth, async (req, res) => {
  const { code, amount, max_uses = 100, expires_at } = req.body || {};
  if (!code || !amount) {
    return res.status(400).json({ success: false, message: 'code and amount are required' });
  }
  try {
    const { rows } = await query(`
      INSERT INTO promo_codes (code, amount, max_uses, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [code.toUpperCase().trim(), parseFloat(amount), parseInt(max_uses), expires_at || null]);
    logger.info('Admin created promo code', { code: rows[0].code, amount });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.status(503).json({ success: false, message: 'Run `node scripts/migrate.js` first to enable promo codes' });
    }
    throw err;
  }
});

router.patch('/api/promo-codes/:id/deactivate', adminAuth, async (req, res) => {
  await query('UPDATE promo_codes SET is_active = FALSE WHERE id = $1', [req.params.id]);
  res.json({ success: true, message: 'Promo code deactivated' });
});

// ── Offers — Bulk wallet bonus ────────────────────────────────────────────────
router.post('/api/offers/wallet-bonus', adminAuth, async (req, res) => {
  const { amount, note, filter = 'all' } = req.body || {};
  const numAmount = parseFloat(amount);
  if (!amount || isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid positive amount required' });
  }

  let whereClause = 'WHERE is_active = TRUE AND is_host = FALSE';
  if (filter === 'active_week') {
    whereClause = "WHERE is_active = TRUE AND is_host = FALSE AND last_seen_at > NOW() - INTERVAL '7 days'";
  }
  if (filter === 'all_including_hosts') {
    whereClause = 'WHERE is_active = TRUE';
  }

  const usersRes = await query(`SELECT id FROM users ${whereClause}`);
  const userIds = usersRes.rows.map((r) => r.id);

  if (userIds.length === 0) {
    return res.json({ success: true, message: 'No users matched the filter', count: 0 });
  }

  await withTransaction(async (client) => {
    // Bulk credit wallets
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = ANY($2::bigint[])',
      [numAmount, userIds]
    );
    // Bulk insert transaction records using unnest
    await client.query(`
      INSERT INTO transactions (user_id, type, status, amount, is_credit, description)
      SELECT unnest($1::bigint[]), 'admin_bonus', 'completed', $2, TRUE, $3
    `, [userIds, numAmount, note || `Platform bonus — ₹${numAmount}`]);
  });

  logger.info('Admin bulk wallet bonus', { amount: numAmount, userCount: userIds.length, filter });
  res.json({ success: true, message: `₹${numAmount} credited to ${userIds.length} users`, count: userIds.length });
});

// ── KYC Management ────────────────────────────────────────────────────────────
router.get('/api/kyc', adminAuth, async (req, res) => {
  const { status = 'pending' } = req.query;
  try {
    const validStatuses = ['pending', 'approved', 'rejected', 'all'];
    const statusFilter = validStatuses.includes(status) ? status : 'pending';
    const where = statusFilter === 'all' ? '' : `WHERE k.status = '${statusFilter}'`;
    const { rows } = await query(`
      SELECT k.id, k.host_id, k.document_type, k.front_url, k.back_url, k.selfie_url,
             k.status, k.rejection_reason, k.submitted_at, k.reviewed_at,
             u.name AS host_name, u.phone AS host_phone, u.avatar AS host_avatar,
             h.is_verified, h.kyc_status
      FROM kyc_documents k
      JOIN hosts h ON h.id = k.host_id
      JOIN users u ON u.id = h.user_id
      ${where}
      ORDER BY k.submitted_at DESC
      LIMIT 100
    `);
    res.json({ success: true, data: rows });
  } catch {
    res.json({ success: true, data: [], _note: 'Run node scripts/migrate.js to enable KYC' });
  }
});

router.patch('/api/kyc/:id/approve', adminAuth, async (req, res) => {
  let notifyUserId = null;
  try {
    await withTransaction(async (client) => {
      // Join hosts to get the user_id for the push notification
      const kycRes = await client.query(`
        SELECT k.*, h.user_id FROM kyc_documents k
        JOIN hosts h ON h.id = k.host_id WHERE k.id = $1
      `, [req.params.id]);
      if (!kycRes.rows[0]) throw { status: 404, message: 'KYC submission not found' };

      notifyUserId = kycRes.rows[0].user_id;

      await client.query(
        `UPDATE kyc_documents SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      await client.query(
        `UPDATE hosts SET kyc_status = 'approved', is_verified = TRUE WHERE id = $1`,
        [kycRes.rows[0].host_id]
      );
    });

    // Push notification — fire and forget (best-effort, outside transaction)
    if (notifyUserId) {
      notifService.sendToUser(notifyUserId, {
        title: '✅ KYC Approved!',
        body: 'Your identity is verified. Payouts are now enabled on your account.',
        data: { type: 'kyc_approved' },
      }).catch(() => {});
    }

    logger.info('Admin KYC approved', { kycId: req.params.id });
    res.json({ success: true, message: 'KYC approved & host verified ✓' });
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.status(503).json({ success: false, message: 'Run `node scripts/migrate.js` first' });
    }
    throw err;
  }
});

router.patch('/api/kyc/:id/reject', adminAuth, async (req, res) => {
  const { reason = 'Document unclear or invalid' } = req.body || {};
  let notifyUserId = null;
  try {
    await withTransaction(async (client) => {
      // Join hosts to get the user_id for the push notification
      const kycRes = await client.query(`
        SELECT k.*, h.user_id FROM kyc_documents k
        JOIN hosts h ON h.id = k.host_id WHERE k.id = $1
      `, [req.params.id]);
      if (!kycRes.rows[0]) throw { status: 404, message: 'KYC submission not found' };

      notifyUserId = kycRes.rows[0].user_id;

      await client.query(
        `UPDATE kyc_documents SET status = 'rejected', rejection_reason = $1, reviewed_at = NOW() WHERE id = $2`,
        [reason, req.params.id]
      );
      await client.query(
        `UPDATE hosts SET kyc_status = 'rejected' WHERE id = $1`,
        [kycRes.rows[0].host_id]
      );
    });

    // Push notification — fire and forget (best-effort, outside transaction)
    if (notifyUserId) {
      notifService.sendToUser(notifyUserId, {
        title: '❌ KYC Not Approved',
        body: `Reason: ${reason}. Please resubmit with valid documents.`,
        data: { type: 'kyc_rejected', reason },
      }).catch(() => {});
    }

    logger.info('Admin KYC rejected', { kycId: req.params.id, reason });
    res.json({ success: true, message: 'KYC rejected' });
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return res.status(503).json({ success: false, message: 'Run `node scripts/migrate.js` first' });
    }
    throw err;
  }
});

// ── Analytics (recent revenue chart data) ────────────────────────────────────
router.get('/api/analytics/revenue', adminAuth, async (req, res) => {
  const { rows } = await query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*)::int    AS call_count,
      COALESCE(SUM(amount_charged), 0) AS revenue,
      COALESCE(SUM(host_earnings),  0) AS host_earnings
    FROM calls
    WHERE status = 'ended' AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  res.json({ success: true, data: rows });
});

module.exports = router;
