const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const ctrl = require('./auth.controller');

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

// POST /api/auth/refresh
router.post('/refresh', ctrl.refresh);

// POST /api/auth/logout  (requires auth)
router.post('/logout', authenticate, ctrl.logout);

// GET /api/auth/me  (requires auth)
router.get('/me', authenticate, ctrl.me);

module.exports = router;
