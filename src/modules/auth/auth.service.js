const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { query } = require('../../config/database');
const { setex, get, del } = require('../../config/redis');
const logger = require('../../config/logger');

const OTP_TTL      = parseInt(process.env.OTP_EXPIRY_SECONDS) || 300; // 5 min
const IS_DEV       = process.env.NODE_ENV !== 'production';
const SMS_PROVIDER = (process.env.SMS_PROVIDER || 'msg91').toLowerCase();
const BCRYPT_ROUNDS = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const generateOtp  = () => Math.floor(100000 + Math.random() * 900000).toString();
const mobileE164   = (phone) => phone.replace('+', '');   // "916369983901"
const mobile10     = (phone) => phone.replace(/^\+91/, '').replace(/\D/g, '');

// ─── Rate-limit helper (shared across all providers) ─────────────────────────
const checkRateLimit = async (phone) => {
  const attempts = parseInt(await get(`otp_attempts:${phone}`)) || 0;
  if (attempts >= 3) throw { status: 429, message: 'Too many OTP requests. Try again in 10 minutes.' };
  await setex(`otp_attempts:${phone}`, 600, String(attempts + 1));
};

// ════════════════════════════════════════════════════════════════════════════════
//  MSG91  — lets MSG91 generate + verify OTP natively (no Redis OTP storage)
// ════════════════════════════════════════════════════════════════════════════════
const sendViaMSG91 = async (phone) => {
  // Do NOT send an `otp` field — MSG91 generates its own and manages expiry
  const res = await axios.post(
    'https://control.msg91.com/api/v5/otp',
    {
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: mobileE164(phone),          // e.g. "916369983901"
    },
    {
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
  if (res.data.type !== 'success') throw new Error(res.data.message || 'MSG91 send failed');
};

const verifyViaMSG91 = async (phone, otp) => {
  // MSG91 verifies against its own stored OTP
  const res = await axios.get(
    'https://control.msg91.com/api/v5/otp/verify',
    {
      params: { otp, mobile: mobileE164(phone) },
      headers: { authkey: process.env.MSG91_AUTH_KEY },
      timeout: 10000,
    }
  );
  if (res.data.type !== 'success') throw { status: 400, message: 'Invalid OTP' };
};

// ════════════════════════════════════════════════════════════════════════════════
//  Fast2SMS  — we generate OTP, store in Redis, verify ourselves
// ════════════════════════════════════════════════════════════════════════════════
const sendViaFast2SMS = async (phone, otp) => {
  const res = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
    params: {
      authorization: process.env.FAST2SMS_API_KEY,
      variables_values: otp,
      route: 'otp',
      numbers: mobile10(phone),
    },
    timeout: 10000,
  });
  if (!res.data.return) throw new Error(res.data.message || 'Fast2SMS failed');
};

// ════════════════════════════════════════════════════════════════════════════════
//  Twilio  — we generate OTP, store in Redis, verify ourselves
// ════════════════════════════════════════════════════════════════════════════════
const sendViaTwilio = async (phone, otp) => {
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await twilio.messages.create({
    body: `Your SocialCall OTP is ${otp}. Valid for 5 minutes. Do not share.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone,
  });
};

// ════════════════════════════════════════════════════════════════════════════════
//  sendOtp  — public entry point
// ════════════════════════════════════════════════════════════════════════════════
const sendOtp = async (phone) => {
  // Rate limit (all providers)
  await checkRateLimit(phone);

  // ── Development mode: skip SMS, log OTP ────────────────────────────────────
  if (IS_DEV) {
    const otp = generateOtp();
    await setex(`otp:${phone}`, OTP_TTL, otp);
    logger.info(`[DEV OTP] ${phone} → ${otp} (NODE_ENV=${process.env.NODE_ENV})`);
    return { message: 'OTP sent successfully' };
  }

  // ── Production ──────────────────────────────────────────────────────────────
  try {
    if (SMS_PROVIDER === 'msg91') {
      // MSG91 stores OTP internally — nothing to write to Redis
      await sendViaMSG91(phone);
    } else {
      // Other providers: we manage the OTP in Redis
      const otp = generateOtp();
      await setex(`otp:${phone}`, OTP_TTL, otp);
      if (SMS_PROVIDER === 'fast2sms') await sendViaFast2SMS(phone, otp);
      else                             await sendViaTwilio(phone, otp);
    }
    logger.info(`OTP sent via ${SMS_PROVIDER}`, { phone });
  } catch (err) {
    logger.error(`${SMS_PROVIDER} OTP send error`, { phone, error: err.message });
    throw { status: 503, message: 'Failed to send OTP. Please try again.' };
  }

  return { message: 'OTP sent successfully' };
};

// ════════════════════════════════════════════════════════════════════════════════
//  verifyOtp  — public entry point
// ════════════════════════════════════════════════════════════════════════════════
const verifyOtp = async (phone, otp) => {
  // ── MSG91 in production: delegate verification to MSG91 ────────────────────
  if (SMS_PROVIDER === 'msg91' && !IS_DEV) {
    try {
      await verifyViaMSG91(phone, otp);
    } catch (err) {
      throw err.status ? err : { status: 400, message: 'Invalid OTP' };
    }
  } else {
    // ── Dev mode + other providers: verify against Redis ─────────────────────
    const storedOtp = await get(`otp:${phone}`);
    if (!storedOtp) throw { status: 400, message: 'OTP expired or not found. Request a new one.' };
    if (String(storedOtp) !== String(otp)) throw { status: 400, message: 'Invalid OTP' };
    await del(`otp:${phone}`);
  }

  // Clear rate limit on success
  await del(`otp_attempts:${phone}`);

  // ── Find or create user ────────────────────────────────────────────────────
  const existing = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  let user;

  if (existing.rows[0]) {
    user = existing.rows[0];
    await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
  } else {
    const { rows } = await query(
      `INSERT INTO users (phone, name, last_seen_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [phone, `User${phone.slice(-4)}`]
    );
    user = rows[0];
    logger.info('New user registered via OTP', { userId: user.id, phone });
  }

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);

  return {
    user: sanitizeUser(user),
    ...tokens,
    isNewUser: !existing.rows[0],
  };
};

// ════════════════════════════════════════════════════════════════════════════════
//  registerWithPassword  — create account with phone + password (no OTP needed)
// ════════════════════════════════════════════════════════════════════════════════
const registerWithPassword = async (phone, password, name, gender) => {
  const existing = await query('SELECT id, password_hash FROM users WHERE phone = $1', [phone]);

  if (existing.rows[0]) {
    if (existing.rows[0].password_hash) {
      throw { status: 409, message: 'Phone number already registered. Please login.' };
    }
    // User exists (via OTP) but has no password yet — just add the password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, existing.rows[0].id]);
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [existing.rows[0].id]);
    const user = rows[0];
    const tokens = generateTokens(user.id);
    await saveRefreshToken(user.id, tokens.refreshToken);
    return { user: sanitizeUser(user), ...tokens, isNewUser: false };
  }

  // Brand new user — create with password (gender is optional/nullable)
  const allowedGenders = ['male', 'female', 'other'];
  const safeGender = allowedGenders.includes(gender) ? gender : null;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (phone, name, password_hash, gender, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
    [phone, name || `User${phone.slice(-4)}`, passwordHash, safeGender]
  );
  const user = rows[0];
  logger.info('New user registered via password', { userId: user.id, phone });

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);

  return { user: sanitizeUser(user), ...tokens, isNewUser: true };
};

// ════════════════════════════════════════════════════════════════════════════════
//  loginWithPassword  — sign in with phone + password
// ════════════════════════════════════════════════════════════════════════════════
const loginWithPassword = async (phone, password) => {
  const { rows } = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  const user = rows[0];

  if (!user) throw { status: 401, message: 'Invalid phone number or password' };
  if (!user.password_hash) throw { status: 400, message: 'This account uses OTP login. Please use the OTP option to sign in.' };
  if (!user.is_active) throw { status: 403, message: 'Account is deactivated. Contact support.' };

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw { status: 401, message: 'Invalid phone number or password' };

  await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
  logger.info('User logged in via password', { userId: user.id, phone });

  const tokens = generateTokens(user.id);
  await saveRefreshToken(user.id, tokens.refreshToken);

  return { user: sanitizeUser(user), ...tokens, isNewUser: false };
};

// ════════════════════════════════════════════════════════════════════════════════
//  setPassword  — set or change password for an authenticated user
// ════════════════════════════════════════════════════════════════════════════════
const setPassword = async (userId, newPassword, currentPassword = null) => {
  const { rows } = await query('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw { status: 404, message: 'User not found' };

  // If user already has a password, verify the current one first
  if (user.password_hash) {
    if (!currentPassword) throw { status: 400, message: 'Current password is required to change password' };
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) throw { status: 401, message: 'Current password is incorrect' };
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  logger.info('Password updated', { userId });

  return { message: user.password_hash ? 'Password changed successfully' : 'Password set successfully' };
};

// ─── Token helpers ────────────────────────────────────────────────────────────
const generateTokens = (userId) => ({
  accessToken: jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  }),
  refreshToken: crypto.randomBytes(64).toString('hex'),
});

const saveRefreshToken = async (userId, token) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
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
  await query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
  await saveRefreshToken(rows[0].user_id, newTokens.refreshToken);
  return newTokens;
};

// ─── Logout ───────────────────────────────────────────────────────────────────
const logout = async (userId, refreshToken) => {
  if (refreshToken) {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1 AND token = $2', [userId, refreshToken]);
  } else {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  }
};

// ─── Sanitize user ────────────────────────────────────────────────────────────
const sanitizeUser = (user) => ({
  id:            user.id,
  name:          user.name,
  phone:         user.phone,
  avatar:        user.avatar,
  walletBalance: parseFloat(user.wallet_balance),
  isHost:        user.is_host,
  hasPassword:   !!user.password_hash,   // tells client if password login is available
  created_at:    user.created_at,
});

module.exports = {
  sendOtp,
  verifyOtp,
  registerWithPassword,
  loginWithPassword,
  setPassword,
  refreshAccessToken,
  logout,
  sanitizeUser,
};
