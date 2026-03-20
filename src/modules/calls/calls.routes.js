const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const { query } = require('../../config/database');
const { get } = require('../../config/redis');
const svc = require('./calls.service');
const { startWalletCheck, isUserOnline } = require('../../socket/socket');
const notifService = require('../notifications/notification.service');

// Per-user: max 3 call initiations per minute (prevents call spam)
const initiateCallLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many call attempts. Please wait a moment.' },
});

// GET /api/calls/:callId/agora-token — returns Agora RTC token for the call.
// Both caller and host call this to get their channel credentials.
// Requires AGORA_APP_ID + AGORA_APP_CERTIFICATE in environment.
router.get('/:callId/agora-token', authenticate, async (req, res) => {
  const result = await svc.getAgoraToken(req.params.callId, req.user.id);
  res.json({ success: true, data: result });
});

// POST /api/calls/initiate — caller starts a call via REST
// After creating the call record the handler also pushes an
// `incoming_call` socket event to the host (exactly like call_request does).
router.post('/initiate', authenticate, initiateCallLimiter,
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

        if (await isUserOnline(hostUserId)) {
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
        } else {
          // Host is offline — send FCM push so they get a heads-up notification
          await notifService.sendToUser(hostUserId, {
            title: '📞 Incoming Call!',
            body: `${caller?.name || 'Someone'} is calling you`,
            data: {
              type:       'call',
              callId:     String(result.callId),
              callType:   req.body.callType,
              callerName: caller?.name || '',
            },
          }).catch(() => {});
        }
      }
    }

    res.json({ success: true, data: result });
  }
);

// POST /api/calls/:callId/accept — host accepts the call via REST
// After accepting, emit `call_connected` to the caller so their
// WebRTC flow can begin.  Also starts the server-side wallet watch so
// the call auto-ends if the caller's balance runs out.
router.post('/:callId/accept', authenticate, async (req, res) => {
  const callId = req.params.callId;
  const result = await svc.acceptCall(callId, req.user.id);

  // ── Notify caller + start server-side wallet guard ────────────────────────
  const io = req.app.get('io');
  if (io) {
    const callRes = await query('SELECT user_id FROM calls WHERE id = $1', [callId]);
    const callerId = callRes.rows[0]?.user_id;

    if (callerId) {
      io.to(`user:${callerId}`).emit('call_connected', {
        callId,
        channelName: result.channelName,
      });

      // Start server-side wallet check (auto-ends call when balance depletes).
      // ratePerMin is cached in Redis by initiateCall.
      const cached = await get(`call:${callId}`);
      if (cached?.ratePerMin) {
        startWalletCheck(io, callId, callerId, cached.ratePerMin);
      }
    }
  }

  res.json({ success: true, data: result });
});

// POST /api/calls/:callId/end — end call + billing
router.post('/:callId/end', authenticate, async (req, res) => {
  const result = await svc.endCall(req.params.callId, req.user.id);
  res.json({ success: true, data: result });
});

// GET /api/calls/history — caller's outgoing call history
router.get('/history', authenticate, async (req, res) => {
  const calls = await svc.getCallHistory(req.user.id, req.query);
  res.json({ success: true, data: calls });
});

// GET /api/calls/history/host — host's incoming call history
router.get('/history/host', authenticate, async (req, res) => {
  const calls = await svc.getHostCallHistory(req.user.id, req.query);
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
