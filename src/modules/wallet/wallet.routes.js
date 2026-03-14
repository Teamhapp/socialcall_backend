const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const { getOnlineUsers } = require('../../socket/socket');
const { query } = require('../../config/database');
const svc = require('./wallet.service');

// GET /api/wallet — get balance + stats
router.get('/', authenticate, async (req, res) => {
  const wallet = await svc.getWallet(req.user.id);
  res.json({ success: true, data: wallet });
});

// POST /api/wallet/order — create Razorpay order
router.post('/order', authenticate,
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
router.post('/gift', authenticate,
  [
    body('hostId').notEmpty().withMessage('hostId required'),
    body('giftId').notEmpty().withMessage('giftId required'),
    validate,
  ],
  async (req, res) => {
    const result = await svc.sendGift(req.user.id, req.body.hostId, req.body.giftId);

    // Notify host in real-time via socket
    try {
      const io = req.app.get('io');
      const { rows } = await query('SELECT user_id FROM hosts WHERE id = $1', [req.body.hostId]);
      if (io && rows[0]) {
        const hostUserId = rows[0].user_id;
        const onlineUsers = getOnlineUsers();
        const socketId = onlineUsers.get(String(hostUserId));
        if (socketId) {
          io.to(socketId).emit('gift_received', {
            senderName: req.user.name,
            gift: result.gift,
            amount: result.amountDeducted * 0.65,
          });
        }
      }
    } catch (_) { /* best-effort */ }

    res.json({ success: true, data: result });
  }
);

// POST /api/wallet/redeem-promo — redeem a promo code for wallet credit
router.post('/redeem-promo', authenticate,
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

module.exports = router;
