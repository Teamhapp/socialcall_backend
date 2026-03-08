const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// ─── Verify JWT token ────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB
    const { rows } = await query(
      'SELECT id, name, phone, avatar, wallet_balance, is_host, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0]) return res.status(401).json({ success: false, message: 'User not found' });
    if (!rows[0].is_active) return res.status(403).json({ success: false, message: 'Account suspended' });

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ─── Must be a verified host ─────────────────────────────────────────────────
const requireHost = async (req, res, next) => {
  if (!req.user.is_host) {
    return res.status(403).json({ success: false, message: 'Host account required' });
  }

  const { rows } = await query(
    'SELECT id, is_active, is_verified FROM hosts WHERE user_id = $1',
    [req.user.id]
  );
  if (!rows[0]) return res.status(403).json({ success: false, message: 'Host profile not found' });

  req.host = rows[0];
  next();
};

// ─── Optional auth (doesn't fail if no token) ───────────────────────────────
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
      if (rows[0]) req.user = rows[0];
    }
  } catch {}
  next();
};

module.exports = { authenticate, requireHost, optionalAuth };
