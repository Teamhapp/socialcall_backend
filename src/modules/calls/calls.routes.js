const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const { query } = require('../../config/database');
const svc = require('./calls.service');

// POST /api/calls/initiate — caller starts a call via REST
// After creating the call record the handler also pushes an
// `incoming_call` socket event to the host (exactly like call_request does).
router.post('/initiate', authenticate,
  [
    body('hostId').notEmpty().withMessage('hostId required'),
    body('callType').isIn(['audio', 'video']).withMessage('callType must be audio or video'),
    validate,
  ],
  async (req, res) => {
    const result = await svc.initiateCall(req.user.id, req.body.hostId, req.body.callType);

    // ── Notify host via Socket.IO ─────────────────────────────────────────────
    const io = req.app.get('io');
    if (io) {
      // Look up the host's user_id so we can address their socket room
      const hostUserRes = await query('SELECT user_id FROM hosts WHERE id = $1', [req.body.hostId]);
      const hostUserId = hostUserRes.rows[0]?.user_id;

      if (hostUserId) {
        // Look up caller name
        const callerRes = await query('SELECT name, avatar FROM users WHERE id = $1', [req.user.id]);
        const caller = callerRes.rows[0];

        io.to(`user:${hostUserId}`).emit('incoming_call', {
          callId: result.callId,
          callType: req.body.callType,
          channelName: result.channelName,
          caller: {
            id: req.user.id,
            name: caller?.name || 'Unknown',
            avatar: caller?.avatar || null,
          },
        });
      }
    }

    res.json({ success: true, data: result });
  }
);

// POST /api/calls/:callId/accept — host accepts the call via REST
// After accepting, emit `call_connected` to the caller so their
// WebRTC flow can begin.
router.post('/:callId/accept', authenticate, async (req, res) => {
  const result = await svc.acceptCall(req.params.callId, req.user.id);

  // ── Notify caller via Socket.IO ───────────────────────────────────────────
  const io = req.app.get('io');
  if (io) {
    const callRes = await query('SELECT user_id FROM calls WHERE id = $1', [req.params.callId]);
    const callerId = callRes.rows[0]?.user_id;

    if (callerId) {
      io.to(`user:${callerId}`).emit('call_connected', {
        callId: req.params.callId,
        channelName: result.channelName,
      });
    }
  }

  res.json({ success: true, data: result });
});

// POST /api/calls/:callId/end — end call + billing
router.post('/:callId/end', authenticate, async (req, res) => {
  const result = await svc.endCall(req.params.callId, req.user.id);
  res.json({ success: true, data: result });
});

// GET /api/calls/history
router.get('/history', authenticate, async (req, res) => {
  const calls = await svc.getCallHistory(req.user.id, req.query);
  res.json({ success: true, data: calls });
});

// POST /api/calls/:callId/review
router.post('/:callId/review', authenticate,
  [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
    body('comment').optional().isLength({ max: 500 }),
    validate,
  ],
  async (req, res) => {
    await svc.submitReview(req.params.callId, req.user.id, req.body);
    res.json({ success: true, message: 'Review submitted' });
  }
);

module.exports = router;
