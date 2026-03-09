const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const ctrl = require('./auth.controller');

// ─── OTP Auth ─────────────────────────────────────────────────────────────────

// POST /api/auth/send-otp
router.post('/send-otp',
  [
    body('phone')
      .trim()
      .notEmpty().withMessage('Phone is required')
      .matches(/^\+?[1-9]\d{7,14}$/).withMessage('Invalid phone number format'),
    validate,
  ],
  ctrl.sendOtp
);

// POST /api/auth/verify-otp
router.post('/verify-otp',
  [
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('otp').trim().isLength({ min: 4, max: 6 }).withMessage('OTP must be 4-6 digits'),
    validate,
  ],
  ctrl.verifyOtp
);

// ─── Password Auth ────────────────────────────────────────────────────────────

// POST /api/auth/register  — create account with phone + password (no OTP)
router.post('/register',
  [
    body('phone')
      .trim()
      .notEmpty().withMessage('Phone is required')
      .matches(/^\+?[1-9]\d{7,14}$/).withMessage('Invalid phone number format'),
    body('password')
      .isLength({ min: 6, max: 100 }).withMessage('Password must be 6–100 characters'),
    body('name')
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 }).withMessage('Name must be 1–100 characters'),
    validate,
  ],
  ctrl.register
);

// POST /api/auth/login-password  — sign in with phone + password
router.post('/login-password',
  [
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('password').notEmpty().withMessage('Password is required'),
    validate,
  ],
  ctrl.loginPassword
);

// POST /api/auth/set-password  — set or change password (must be logged in)
router.post('/set-password',
  authenticate,
  [
    body('newPassword')
      .isLength({ min: 6, max: 100 }).withMessage('New password must be 6–100 characters'),
    body('currentPassword')
      .optional()
      .notEmpty().withMessage('Current password cannot be blank if provided'),
    validate,
  ],
  ctrl.setPassword
);

// ─── Shared ───────────────────────────────────────────────────────────────────

// POST /api/auth/refresh
router.post('/refresh', ctrl.refresh);

// POST /api/auth/logout  (requires auth)
router.post('/logout', authenticate, ctrl.logout);

// GET /api/auth/me  (requires auth)
router.get('/me', authenticate, ctrl.me);

module.exports = router;
