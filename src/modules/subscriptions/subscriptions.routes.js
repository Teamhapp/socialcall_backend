const router = require('express').Router();
const { authenticate } = require('../../middleware/auth');
const svc = require('./subscriptions.service');
const { query } = require('../../config/database');

// POST /api/subscriptions/:hostId — subscribe to a host
router.post('/:hostId', authenticate, async (req, res) => {
  const subscription = await svc.subscribe(req.user.id, req.params.hostId);

  // Notify host via socket
  const io = req.app.get('io');
  const hostUserRes = await query('SELECT user_id FROM hosts WHERE id = $1', [req.params.hostId]);
  const hostUserId = hostUserRes.rows[0]?.user_id;
  if (io && hostUserId) {
    const userRes = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    io.to(`user_${hostUserId}`).emit('new_subscriber', {
      subscriberName: userRes.rows[0]?.name || 'Someone',
      subscriberId: req.user.id,
    });
  }

  res.status(201).json({ success: true, data: subscription });
});

// GET /api/subscriptions/status/:hostId — check subscription status
router.get('/status/:hostId', authenticate, async (req, res) => {
  const status = await svc.getStatus(req.user.id, req.params.hostId);
  res.json({ success: true, data: status });
});

// DELETE /api/subscriptions/:hostId — unsubscribe
router.delete('/:hostId', authenticate, async (req, res) => {
  const sub = await svc.unsubscribe(req.user.id, req.params.hostId);
  res.json({ success: true, data: sub });
});

module.exports = router;
