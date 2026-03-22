const authService = require('./auth.service');

// POST /api/auth/send-otp
const sendOtp = async (req, res) => {
  const { phone } = req.body;
  const result = await authService.sendOtp(phone);
  res.json({ success: true, ...result });
};

// POST /api/auth/verify-otp
const verifyOtp = async (req, res) => {
  const { phone, otp } = req.body;
  const result = await authService.verifyOtp(phone, otp);
  res.json({ success: true, message: 'Login successful', data: result });
};

// POST /api/auth/register  — sign up with phone + password (no OTP needed)
const register = async (req, res) => {
  const { phone, password, name, gender } = req.body;
  const result = await authService.registerWithPassword(phone, password, name, gender);
  res.status(result.isNewUser ? 201 : 200).json({
    success: true,
    message: result.isNewUser ? 'Registration successful' : 'Password added to existing account',
    data: result,
  });
};

// POST /api/auth/login-password  — sign in with phone + password
const loginPassword = async (req, res) => {
  const { phone, password } = req.body;
  const result = await authService.loginWithPassword(phone, password);
  res.json({ success: true, message: 'Login successful', data: result });
};

// POST /api/auth/set-password  — set or change password (authenticated)
const setPassword = async (req, res) => {
  const { newPassword, currentPassword } = req.body;
  const result = await authService.setPassword(req.user.id, newPassword, currentPassword);
  res.json({ success: true, ...result });
};

// POST /api/auth/refresh
const refresh = async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });
  const tokens = await authService.refreshAccessToken(refreshToken);
  res.json({ success: true, data: tokens });
};

// POST /api/auth/logout
const logout = async (req, res) => {
  const { refreshToken } = req.body;
  await authService.logout(req.user.id, refreshToken);
  res.json({ success: true, message: 'Logged out successfully' });
};

// GET /api/auth/me
const me = async (req, res) => {
  res.json({ success: true, data: authService.sanitizeUser(req.user) });
};

module.exports = { sendOtp, verifyOtp, register, loginPassword, setPassword, refresh, logout, me };
