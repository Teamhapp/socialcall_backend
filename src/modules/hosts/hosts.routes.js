const router = require('express').Router();
const { body, query: qv, param } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate, requireHost, optionalAuth } = require('../../middleware/auth');
const svc = require('./hosts.service');

// GET /api/hosts — list / search hosts
router.get('/', optionalAuth, async (req, res) => {
  const result = await svc.getHosts(req.query);
  res.json({ success: true, data: result });
});

// GET /api/hosts/:id — single host profile
router.get('/:id', optionalAuth, async (req, res) => {
  const host = await svc.getHostById(req.params.id, req.user?.id);
  res.json({ success: true, data: host });
});

// POST /api/hosts/profile — create host profile (auth required)
router.post('/profile', authenticate,
  [
    body('bio').optional().isLength({ max: 500 }),
    body('languages').isArray({ min: 1 }).withMessage('At least one language required'),
    body('audioRate').isFloat({ min: 5, max: 500 }).withMessage('Audio rate must be ₹5-500'),
    body('videoRate').isFloat({ min: 10, max: 1000 }).withMessage('Video rate must be ₹10-1000'),
    validate,
  ],
  async (req, res) => {
    const host = await svc.createHostProfile(req.user.id, req.body);
    res.status(201).json({ success: true, message: 'Host profile created', data: host });
  }
);

// PUT /api/hosts/profile — update host profile
router.put('/profile', authenticate, requireHost, async (req, res) => {
  const host = await svc.updateHostProfile(req.user.id, req.body);
  res.json({ success: true, data: host });
});

// PATCH /api/hosts/status — go online/offline
router.patch('/status', authenticate, requireHost,
  [
    body('isOnline').isBoolean().withMessage('isOnline must be boolean'),
    validate,
  ],
  async (req, res) => {
    await svc.setOnlineStatus(req.user.id, req.body.isOnline);
    // Broadcast status change to all connected clients
    req.app.get('io')?.emit('host_status_changed', {
      userId: req.user.id,
      isOnline: req.body.isOnline,
    });
    res.json({ success: true, message: `Status set to ${req.body.isOnline ? 'online' : 'offline'}` });
  }
);

// POST /api/hosts/:id/follow — follow / unfollow
router.post('/:id/follow', authenticate, async (req, res) => {
  const result = await svc.toggleFollow(req.user.id, req.params.id);
  res.json({ success: true, ...result });
});

module.exports = router;
