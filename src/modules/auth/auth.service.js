const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, withTransaction } = require('../../config/database');
const { setex, get, del } = require('../../config/redis');
const logger = require('../../config/logger');

const OTP_TTL = parseInt(process.env.OTP_EXPIRY_SECONDS) || 300; // 5 minutes
const PLATFORM = process.env.NODE_ENV === 'development'; // dev: skip real OTP

// ─── Generate 4-digit OTP ────────────────────────────────────────────────────
const generateOtp = () => Math.floor(1000 + Math.random() * 9000).toString();

// ─── Send OTP via Twilio ─────────────────────────────────────────────────────
const sendOtp = async (phone) => {
  const otp = generateOtp();
  const key = `otp:${phone}`;

  // Rate limit: max 3 OTPs per 10 minutes
  const attempts = await get(`otp_attempts:${phone}`) || 0;
  if (attempts >= 3) throw { status: 429, message: 'Too many OTP requests. Try again in 10 minutes.' };

  await setex(key, OTP_TTL, otp);
  await setex(`otp_attempts:${phone}`, 600, String(parseInt(attempts) + 1));

  if (PLATFORM) {
    // Development: log OTP to console
    logger.info(`[DEV OTP] ${phone} → ${otp}`);
    return { message: `OTP sent (dev: ${otp})`, otp }; // remove otp in prod
  }

  // Production: send via Twilio
  try {
    const twilio = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    await twilio.messages.create({
      body: `Your SocialCall OTP is: ${otp}. Valid for 5 minutes. Do not share with anyone.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
  } catch (err) {
    logger.error('Twilio error', { phone, error: err.message });
    throw { status: 503, message: 'Failed to send OTP. Please try again.' };
  }

  return { message: 'OTP sent successfully' };
};

// ─── Verify OTP and login/register ───────────────────────────────────────────
const verifyOtp = async (phone, otp) => {
  const key = `otp:${phone}`;
  const storedOtp = await get(key);

  if (!storedOtp) throw { status: 400, message: 'OTP expired or not found. Request a new one.' };
  if (String(storedOtp) !== String(otp)) throw { status: 400, message: 'Invalid OTP' };

  // OTP consumed — delete it
  await del(key);
  await del(`otp_attempts:${phone}`);

  // Find or create user
  let user;
  const existing = await query('SELECT * FROM users WHERE phone = $1', [phone]);

  if (existing.rows[0]) {
    user = existing.rows[0];
    // Update last seen
    await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
  } else {
    // New user registration
    const { rows } = await query(
      `INSERT INTO users (phone, name, last_seen_at)
       VALUES ($1, $2, NOW())
       RETURNING *`,
      [phone, `User${phone.slice(-4)}`]
    );
    user = rows[0];
    logger.info('New user registered', { userId: user.id, phone });
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);

  return {
    user: sanitizeUser(user),
    ...tokens,
    isNewUser: !existing.rows[0],
  };
};

// ─── Token generation ─────────────────────────────────────────────────────────
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  const refreshToken = crypto.randomBytes(64).toString('hex');
  return { accessToken, refreshToken };
};

const saveRefreshToken = async (userId, token) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userId, token, expiresAt]
  );
};

// ─── Refresh access token ─────────────────────────────────────────────────────
const refreshAccessToken = async (refreshToken) => {
  const { rows } = await query(
    `SELECT rt.*, u.id as uid FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token = $1 AND rt.expires_at > NOW()`,
    [refreshToken]
  );

  if (!rows[0]) throw { status: 401, message: 'Invalid or expired refresh token' };

  const newTokens = generateTokens(rows[0].user_id);
  // Rotate refresh token
  await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
  await saveRefreshToken(rows[0].user_id, newTokens.refreshToken);

  return newTokens;
};

// ─── Logout ──────────────────────────────────────────────────────────────────
const logout = async (userId, refreshToken) => {
  if (refreshToken) {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1 AND token = $2', [userId, refreshToken]);
  } else {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  }
};

// ─── Sanitize user for response ───────────────────────────────────────────────
const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  avatar: user.avatar,
  walletBalance: parseFloat(user.wallet_balance),
  isHost: user.is_host,
});

module.exports = { sendOtp, verifyOtp, refreshAccessToken, logout, sanitizeUser };
