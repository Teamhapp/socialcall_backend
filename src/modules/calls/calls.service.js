const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../../config/database');
const { setex, get, del } = require('../../config/redis');
const logger = require('../../config/logger');

const COMMISSION = parseInt(process.env.PLATFORM_COMMISSION_PERCENT) || 35;

// ─── Initiate Call ─────────────────────────────────────────────────────────────
const initiateCall = async (userId, hostId, callType) => {
  return withTransaction(async (client) => {
    // Get user and host details
    const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const hostRes = await client.query('SELECT h.*, u.fcm_token, u.name FROM hosts h JOIN users u ON u.id = h.user_id WHERE h.id = $1', [hostId]);

    const user = userRes.rows[0];
    const host = hostRes.rows[0];

    if (!host) throw { status: 404, message: 'Host not found' };
    if (!host.is_online) throw { status: 400, message: 'Host is currently offline' };
    if (!host.is_active) throw { status: 400, message: 'Host is not available' };

    const ratePerMin = callType === 'video' ? host.video_rate_per_min : host.audio_rate_per_min;

    // Check wallet balance (minimum 1 minute)
    if (parseFloat(user.wallet_balance) < parseFloat(ratePerMin)) {
      throw { status: 400, message: `Insufficient balance. Minimum ₹${ratePerMin} required for 1 minute.` };
    }

    // Check if user already in a call
    const activeCall = await client.query(
      `SELECT id FROM calls WHERE user_id = $1 AND status IN ('initiated','ringing','connected')`,
      [userId]
    );
    if (activeCall.rows[0]) throw { status: 400, message: 'You already have an active call' };

    // Create channel name
    const channelName = `call_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Create call record
    const { rows } = await client.query(`
      INSERT INTO calls (user_id, host_id, call_type, status, channel_name, rate_per_min)
      VALUES ($1, $2, $3, 'ringing', $4, $5)
      RETURNING *
    `, [userId, hostId, callType, channelName, ratePerMin]);

    const call = rows[0];

    // Cache active call state in Redis
    await setex(`call:${call.id}`, 7200, {
      callId: call.id,
      userId,
      hostId,
      channelName,
      ratePerMin: parseFloat(ratePerMin),
      startedAt: null,
    });

    return {
      callId: call.id,
      channelName,
      callType,
      ratePerMin: parseFloat(ratePerMin),
      host: { id: host.id, name: host.name, fcmToken: host.fcm_token },
    };
  });
};

// ─── Accept Call (by host) ────────────────────────────────────────────────────
const acceptCall = async (callId, hostUserId) => {
  const { rows } = await query(`
    UPDATE calls SET status = 'connected', started_at = NOW()
    WHERE id = $1 AND status = 'ringing'
    RETURNING *
  `, [callId]);

  if (!rows[0]) throw { status: 400, message: 'Call not found or already ended' };

  const call = rows[0];

  // Update Redis with start time
  const cached = await get(`call:${call.id}`);
  if (cached) {
    await setex(`call:${call.id}`, 7200, { ...cached, startedAt: new Date().toISOString() });
  }

  return { callId, channelName: call.channel_name };
};

// ─── End Call + Billing ───────────────────────────────────────────────────────
const endCall = async (callId, endedBy) => {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM calls WHERE id = $1', [callId]);
    if (!rows[0]) throw { status: 404, message: 'Call not found' };

    const call = rows[0];
    if (['ended', 'failed'].includes(call.status)) return { message: 'Call already ended' };

    // Calculate duration
    const startedAt = call.started_at ? new Date(call.started_at) : new Date();
    const endedAt = new Date();
    const durationSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
    const durationMinutes = durationSeconds / 60;

    // Grace period: calls under 10 seconds are free (network glitch / accidental connect)
    const GRACE_PERIOD_SECONDS = 10;
    let amountRounded = 0;
    if (durationSeconds >= GRACE_PERIOD_SECONDS) {
      const amountCharged = Math.min(
        parseFloat(call.rate_per_min) * durationMinutes,
        // Get current user balance
        parseFloat((await client.query('SELECT wallet_balance FROM users WHERE id = $1', [call.user_id])).rows[0]?.wallet_balance || 0)
      );
      amountRounded = Math.round(amountCharged * 100) / 100;
    }
    const hostEarnings = Math.round(amountRounded * (1 - COMMISSION / 100) * 100) / 100;

    // Update call record
    await client.query(`
      UPDATE calls SET
        status = 'ended',
        duration_seconds = $1,
        amount_charged = $2,
        host_earnings = $3,
        ended_at = NOW()
      WHERE id = $4
    `, [durationSeconds, amountRounded, hostEarnings, callId]);

    if (amountRounded > 0) {
      // Deduct from user wallet
      const userResult = await client.query(`
        UPDATE users SET wallet_balance = wallet_balance - $1
        WHERE id = $2 AND wallet_balance >= $1
        RETURNING wallet_balance
      `, [amountRounded, call.user_id]);

      if (!userResult.rows[0]) {
        // Deduct whatever is left
        await client.query('UPDATE users SET wallet_balance = 0 WHERE id = $1', [call.user_id]);
      }

      const balanceAfter = parseFloat(userResult.rows[0]?.wallet_balance || 0);

      // Log transaction for user
      await client.query(`
        INSERT INTO transactions (user_id, type, status, amount, is_credit, balance_after, description, reference_id)
        VALUES ($1, 'call_charge', 'completed', $2, FALSE, $3, $4, $5)
      `, [call.user_id, amountRounded, balanceAfter, `${call.call_type === 'video' ? 'Video' : 'Audio'} call (${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s)`, callId]);

      // Credit host earnings
      await client.query(`
        UPDATE hosts SET
          total_earnings = total_earnings + $1,
          pending_earnings = pending_earnings + $1,
          total_calls = total_calls + 1
        WHERE id = $2
      `, [hostEarnings, call.host_id]);
    }

    // Clean up Redis
    await del(`call:${callId}`);

    logger.info('Call ended', { callId, durationSeconds, amountCharged: amountRounded, hostEarnings });

    return {
      callId,
      durationSeconds,
      amountCharged: amountRounded,
      hostEarnings,
    };
  });
};

// ─── Get Call History ─────────────────────────────────────────────────────────
const getCallHistory = async (userId, { page = 1, limit = 20 }) => {
  const offset = (page - 1) * limit;
  const { rows } = await query(`
    SELECT c.*, h.user_id AS host_user_id, u.name AS host_name, u.avatar AS host_avatar
    FROM calls c
    JOIN hosts h ON h.id = c.host_id
    JOIN users u ON u.id = h.user_id
    WHERE c.user_id = $1
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);

  return rows;
};

// ─── Get Call History for a Host (calls they received) ───────────────────────
const getHostCallHistory = async (hostUserId, { page = 1, limit = 20 }) => {
  const offset = (page - 1) * limit;
  const { rows } = await query(`
    SELECT c.*, u.name AS caller_name, u.avatar AS caller_avatar
    FROM calls c
    JOIN hosts h ON h.id = c.host_id
    JOIN users u ON u.id = c.user_id
    WHERE h.user_id = $1 AND c.status = 'ended'
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [hostUserId, limit, offset]);
  return rows;
};

// ─── Submit Review ────────────────────────────────────────────────────────────
const submitReview = async (callId, userId, { rating, comment }) => {
  return withTransaction(async (client) => {
    const callRes = await client.query(
      `SELECT * FROM calls WHERE id = $1 AND user_id = $2 AND status = 'ended'`,
      [callId, userId]
    );
    if (!callRes.rows[0]) throw { status: 404, message: 'Call not found or not completed' };

    const call = callRes.rows[0];
    await client.query(`
      INSERT INTO reviews (call_id, user_id, host_id, rating, comment)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (call_id) DO UPDATE SET rating = $4, comment = $5
    `, [callId, userId, call.host_id, rating, comment]);

    // Recalculate host rating
    const { updateHostRating } = require('../hosts/hosts.service');
    await updateHostRating(call.host_id);
  });
};

module.exports = { initiateCall, acceptCall, endCall, getCallHistory, getHostCallHistory, submitReview };
