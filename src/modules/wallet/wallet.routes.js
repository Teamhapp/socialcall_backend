const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const { query } = require('../../config/database');
const svc = require('./wallet.service');

// Per-user rate limiters
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 min
  max: 3,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment attempts. Please wait 10 minutes.' },
});

const giftLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 min
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Sending gifts too quickly. Please slow down.' },
});

const promoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many promo code attempts. Try again later.' },
});

// GET /api/wallet — get balance + stats
router.get('/', authenticate, async (req, res) => {
  const wallet = await svc.getWallet(req.user.id);
  res.json({ success: true, data: wallet });
});

// POST /api/wallet/order — create Razorpay order
router.post('/order', authenticate, orderLimiter,
  [
    body('amount').isFloat({ min: 10 }).withMessage('Minimum recharge is ₹10'),
    validate,
  ],
  async (req, res) => {
    const order = await svc.createOrder(req.user.id, req.body.amount);
    res.json({ success: true, data: order });
  }
);

// POST /api/wallet/verify — verify Razorpay payment + credit wallet
router.post('/verify', authenticate,
  [
    body('razorpayOrderId').notEmpty(),
    body('razorpayPaymentId').notEmpty(),
    body('razorpaySignature').notEmpty(),
    validate,
  ],
  async (req, res) => {
    const result = await svc.verifyPayment(req.user.id, req.body);
    // Send push notification
    try {
      const notifSvc = require('../notifications/notification.service');
      await notifSvc.sendToUser(req.user.id, {
        title: '💰 Wallet Recharged!',
        body: `₹${result.amount} added. New balance: ₹${result.newBalance.toFixed(2)}`,
      });
    } catch {}
    res.json({ success: true, message: 'Wallet recharged successfully', data: result });
  }
);

// GET /api/wallet/transactions — transaction history
router.get('/transactions', authenticate, async (req, res) => {
  const txns = await svc.getTransactions(req.user.id, req.query);
  res.json({ success: true, data: txns });
});

// POST /api/wallet/gift — send a gift
router.post('/gift', authenticate, giftLimiter,
  [
    body('hostId').notEmpty().withMessage('hostId required'),
    body('giftId').notEmpty().withMessage('giftId required'),
    validate,
  ],
  async (req, res) => {
    const result = await svc.sendGift(req.user.id, req.body.hostId, req.body.giftId);

    // Notify host in real-time via socket.
    // BUG FIX: use the persistent room `user:{hostUserId}` instead of the raw
    // socketId from onlineUsers.  Rooms survive reconnects; a stale socketId
    // would silently drop the event if the host reconnected since last lookup.
    try {
      const io = req.app.get('io');
      const { rows } = await query('SELECT user_id FROM hosts WHERE id = $1', [req.body.hostId]);
      if (io && rows[0]) {
        const hostUserId = rows[0].user_id;
        io.to(`user:${hostUserId}`).emit('gift_received', {
          senderName: req.user.name,
          gift: result.gift,
          amount: result.amountDeducted * 0.65,
        });
      }
    } catch (_) { /* best-effort */ }

    res.json({ success: true, data: result });
  }
);

// POST /api/wallet/redeem-promo — redeem a promo code for wallet credit
router.post('/redeem-promo', authenticate, promoLimiter,
  [
    body('code').notEmpty().withMessage('Promo code is required'),
    validate,
  ],
  async (req, res) => {
    const result = await svc.redeemPromoCode(req.user.id, req.body.code);
    res.json({
      success: true,
      message: `🎉 ₹${result.amount} credited! New balance: ₹${result.newBalance.toFixed(2)}`,
      data: result,
    });
  }
);

// GET /api/wallet/gifts — available gifts catalogue
router.get('/gifts', async (req, res) => {
  const { query } = require('../../config/database');
  const { rows } = await query('SELECT * FROM gifts WHERE is_active = TRUE ORDER BY price ASC');
  res.json({ success: true, data: rows });
});

// GET /api/wallet/referral — get user's referral code + stats
router.get('/referral', authenticate, async (req, res) => {
  const { rows } = await query(
    `SELECT u.referral_code,
      (SELECT COUNT(*) FROM users WHERE referred_by = u.id) AS referral_count,
      (SELECT COALESCE(SUM(amount),0) FROM transactions
        WHERE user_id = u.id AND type = 'referral_bonus') AS total_earned
     FROM users u WHERE u.id = $1`,
    [req.user.id]
  );
  res.json({ success: true, data: rows[0] });
});

// POST /api/wallet/referral/apply — apply a referral code (one-time per user)
router.post('/referral/apply',
  authenticate,
  [body('code').notEmpty().withMessage('Referral code is required'), validate],
  async (req, res) => {
    // Already used referral
    const selfRes = await query('SELECT referred_by, referral_code FROM users WHERE id = $1', [req.user.id]);
    if (selfRes.rows[0]?.referred_by) {
      return res.status(409).json({ success: false, message: 'You have already used a referral code.' });
    }

    const code = req.body.code.toUpperCase().trim();
    // Can't use own code
    if (selfRes.rows[0]?.referral_code === code) {
      return res.status(400).json({ success: false, message: 'You cannot use your own referral code.' });
    }

    const refRes = await query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!refRes.rows[0]) {
      return res.status(404).json({ success: false, message: 'Invalid referral code.' });
    }
    const referrerId = refRes.rows[0].id;

    // Credit ₹50 to both parties
    const BONUS = 50;
    await query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, req.user.id]);

    // Credit new user
    const newUserRes = await query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
      [BONUS, req.user.id]
    );
    await query(
      `INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description)
       VALUES ($1, 'referral_bonus', 'completed', $2, TRUE, $3, 'Referral sign-up bonus')`,
      [req.user.id, BONUS, newUserRes.rows[0].wallet_balance]
    );

    // Credit referrer
    const referrerRes = await query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
      [BONUS, referrerId]
    );
    await query(
      `INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description)
       VALUES ($1, 'referral_bonus', 'completed', $2, TRUE, $3, 'Referral friend bonus')`,
      [referrerId, BONUS, referrerRes.rows[0].wallet_balance]
    );

    res.json({ success: true, message: `₹${BONUS} coins credited to your wallet!` });
  }
);

module.exports = router;
