const Razorpay = require('razorpay');
const crypto = require('crypto');
const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Get Wallet Balance + Stats ───────────────────────────────────────────────
const getWallet = async (userId) => {
  const { rows } = await query(`
    SELECT
      u.wallet_balance,
      COUNT(t.id) FILTER (WHERE t.type = 'recharge') AS total_recharges,
      COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'recharge'), 0) AS total_recharged,
      COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'call_charge'), 0) AS total_spent_on_calls
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id AND t.status = 'completed'
    WHERE u.id = $1
    GROUP BY u.wallet_balance
  `, [userId]);

  return rows[0];
};

// ─── Create Razorpay Order ─────────────────────────────────────────────────────
const createOrder = async (userId, amountInRupees) => {
  if (amountInRupees < 10) throw { status: 400, message: 'Minimum recharge is ₹10' };
  if (amountInRupees > 100000) throw { status: 400, message: 'Maximum recharge is ₹1,00,000' };

  const amountInPaise = Math.round(amountInRupees * 100);

  // Create Razorpay order (dev mock when real keys not configured)
  let rzpOrder;
  const isDev = process.env.NODE_ENV === 'development';
  const hasRealKeys = process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes('xxx');

  if (isDev && !hasRealKeys) {
    rzpOrder = { id: `order_dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    logger.info('[DEV] Mock Razorpay order', { orderId: rzpOrder.id });
  } else {
    try {
      rzpOrder = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `wallet_${userId}_${Date.now()}`,
        notes: { userId, purpose: 'wallet_recharge' },
      });
    } catch (err) {
      logger.error('Razorpay order creation failed', { userId, error: err.message });
      throw { status: 503, message: 'Payment service unavailable. Please try again.' };
    }
  }

  // Save order to DB
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  await query(`
    INSERT INTO wallet_orders (user_id, razorpay_order_id, amount, expires_at)
    VALUES ($1, $2, $3, $4)
  `, [userId, rzpOrder.id, amountInRupees, expiresAt]);

  return {
    orderId: rzpOrder.id,
    amount: amountInRupees,
    amountInPaise,
    currency: 'INR',
    keyId: process.env.RAZORPAY_KEY_ID,
  };
};

// ─── Verify Payment + Credit Wallet ───────────────────────────────────────────
const verifyPayment = async (userId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  // 1. Verify Razorpay signature (HMAC-SHA256)
  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn('Invalid Razorpay signature', { userId, razorpayPaymentId });
    throw { status: 400, message: 'Payment verification failed. Contact support.' };
  }

  return withTransaction(async (client) => {
    // 2. Get order amount from DB
    const orderRes = await client.query(`
      SELECT * FROM wallet_orders
      WHERE razorpay_order_id = $1 AND user_id = $2 AND status = 'created'
    `, [razorpayOrderId, userId]);

    if (!orderRes.rows[0]) throw { status: 400, message: 'Order not found or already processed' };
    if (new Date(orderRes.rows[0].expires_at) < new Date()) {
      throw { status: 400, message: 'Order has expired' };
    }

    const amount = parseFloat(orderRes.rows[0].amount);

    // 3. Credit wallet
    const userRes = await client.query(`
      UPDATE users SET wallet_balance = wallet_balance + $1
      WHERE id = $2
      RETURNING wallet_balance
    `, [amount, userId]);

    const newBalance = parseFloat(userRes.rows[0].wallet_balance);

    // 4. Mark order as paid
    await client.query(`
      UPDATE wallet_orders SET status = 'paid' WHERE razorpay_order_id = $1
    `, [razorpayOrderId]);

    // 5. Log transaction
    await client.query(`
      INSERT INTO transactions
        (user_id, type, status, amount, is_credit, balance_after, description,
         razorpay_order_id, razorpay_payment_id)
      VALUES ($1, 'recharge', 'completed', $2, TRUE, $3, $4, $5, $6)
    `, [userId, amount, newBalance, `Wallet recharge via Razorpay`, razorpayOrderId, razorpayPaymentId]);

    logger.info('Wallet recharged', { userId, amount, paymentId: razorpayPaymentId });

    return { amount, newBalance, paymentId: razorpayPaymentId };
  });
};

// ─── Transaction History ──────────────────────────────────────────────────────
const getTransactions = async (userId, { page = 1, limit = 20, type }) => {
  const offset = (page - 1) * limit;
  const conditions = ['user_id = $1'];
  const params = [userId];

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  params.push(limit, offset);

  const { rows } = await query(`
    SELECT * FROM transactions
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  return rows;
};

// ─── Gift sending ─────────────────────────────────────────────────────────────
const sendGift = async (senderId, receiverHostId, giftId) => {
  return withTransaction(async (client) => {
    // Get gift price
    const giftRes = await client.query('SELECT * FROM gifts WHERE id = $1 AND is_active = TRUE', [giftId]);
    if (!giftRes.rows[0]) throw { status: 404, message: 'Gift not found' };

    const gift = giftRes.rows[0];
    const price = parseFloat(gift.price);

    // Deduct from sender wallet
    const senderRes = await client.query(`
      UPDATE users SET wallet_balance = wallet_balance - $1
      WHERE id = $2 AND wallet_balance >= $1
      RETURNING wallet_balance
    `, [price, senderId]);

    if (!senderRes.rows[0]) {
      throw { status: 400, message: `Insufficient balance. ${gift.name} costs ₹${price}` };
    }

    const senderBalance = parseFloat(senderRes.rows[0].wallet_balance);

    // Credit host earnings
    const hostEarnings = price * 0.65; // 65% to host
    await client.query(`
      UPDATE hosts SET
        total_earnings = total_earnings + $1,
        pending_earnings = pending_earnings + $1
      WHERE id = $2
    `, [hostEarnings, receiverHostId]);

    // Log transactions
    await client.query(`
      INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description, reference_id)
      VALUES ($1, 'gift_sent', 'completed', $2, FALSE, $3, $4, $5)
    `, [senderId, price, senderBalance, `Sent ${gift.emoji} ${gift.name} gift`, giftId]);

    return { gift, amountDeducted: price, senderBalance };
  });
};

// ─── Redeem Promo Code ────────────────────────────────────────────────────────
const redeemPromoCode = async (userId, code) => {
  return withTransaction(async (client) => {
    // Validate code
    const codeRes = await client.query(`
      SELECT * FROM promo_codes
      WHERE code = $1 AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
        AND used_count < max_uses
    `, [code.toUpperCase().trim()]);

    if (!codeRes.rows[0]) {
      throw { status: 400, message: 'Invalid, expired, or fully used promo code' };
    }

    const promo = codeRes.rows[0];

    // Check if user already redeemed
    const alreadyUsed = await client.query(
      'SELECT id FROM promo_redemptions WHERE code_id = $1 AND user_id = $2',
      [promo.id, userId]
    );
    if (alreadyUsed.rows[0]) {
      throw { status: 400, message: 'You have already redeemed this code' };
    }

    // Credit wallet
    const userRes = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2 RETURNING wallet_balance',
      [promo.amount, userId]
    );
    const newBalance = parseFloat(userRes.rows[0].wallet_balance);

    // Log transaction
    await client.query(`
      INSERT INTO transactions
        (user_id, type, status, amount, is_credit, balance_after, description, reference_id)
      VALUES ($1, 'promo_credit', 'completed', $2, TRUE, $3, $4, $5)
    `, [userId, promo.amount, newBalance, `Promo code: ${promo.code}`, String(promo.id)]);

    // Record redemption
    await client.query(
      'INSERT INTO promo_redemptions (code_id, user_id) VALUES ($1, $2)',
      [promo.id, userId]
    );

    // Increment used_count
    await client.query(
      'UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1',
      [promo.id]
    );

    logger.info('Promo code redeemed', { userId, code: promo.code, amount: promo.amount });
    return { amount: promo.amount, newBalance, code: promo.code };
  });
};

module.exports = { getWallet, createOrder, verifyPayment, getTransactions, sendGift, redeemPromoCode };
