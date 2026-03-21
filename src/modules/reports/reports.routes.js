const router = require('express').Router();
const { body, query: qv } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const svc = require('./reports.service');

const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reports submitted. Please wait before reporting again.' },
});

// ─── Admin auth helper (same pattern as admin.routes.js) ─────────────────────
const adminAuth = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.query.adminSecret;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// POST /api/reports — submit a report (user auth)
router.post('/',
  authenticate,
  reportLimiter,
  [
    body('targetType').isIn(['host', 'message', 'call']).withMessage('Invalid target type'),
    body('targetId').isUUID().withMessage('targetId must be a valid UUID'),
    body('reason').isIn(['inappropriate', 'fake_profile', 'spam', 'harassment', 'other']).withMessage('Invalid reason'),
    body('description').optional().isLength({ max: 500 }),
    validate,
  ],
  async (req, res) => {
    const { targetType, targetId, reason, description } = req.body;
    const report = await svc.submitReport(req.user.id, { targetType, targetId, reason, description });
    res.status(201).json({ success: true, message: 'Report submitted. Our team will review it shortly.', data: report });
  }
);

// GET /api/admin/reports — list reports (admin only)
router.get('/admin',
  adminAuth,
  async (req, res) => {
    const result = await svc.getReports(req.query);
    res.json({ success: true, data: result });
  }
);

// PATCH /api/admin/reports/:id — take action on a report (admin only)
router.patch('/admin/:id',
  adminAuth,
  [
    body('action').isIn(['dismiss', 'warn', 'suspend']).withMessage('action must be dismiss, warn, or suspend'),
    body('adminNote').optional().isLength({ max: 500 }),
    validate,
  ],
  async (req, res) => {
    // Use a system admin UUID for reviewed_by (or pass from admin session if available)
    const adminUserId = req.body.adminUserId || '00000000-0000-0000-0000-000000000000';
    const result = await svc.reviewReport(adminUserId, req.params.id, req.body);
    res.json({ success: true, data: result });
  }
);

module.exports = router;
