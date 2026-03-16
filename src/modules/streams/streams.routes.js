const router = require('express').Router();
const { authenticate, optionalAuth } = require('../../middleware/auth');
const svc = require('./streams.service');

// GET /api/streams — list all active streams (public)
router.get('/', optionalAuth, async (req, res) => {
  const streams = await svc.listStreams();
  res.json({ success: true, data: streams });
});

// POST /api/streams/go-live — host starts a stream
router.post('/go-live', authenticate, async (req, res) => {
  const { title } = req.body || {};
  const result = await svc.goLive(req.user.id, title);

  const io = req.app.get('io');
  io?.emit('stream_started', {
    streamId: result.stream.id,
    hostUserId: req.user.id,
    title: result.stream.title,
    roomName: result.stream.room_name,
  });

  res.status(201).json({ success: true, data: result });
});

// DELETE /api/streams/:id/end — host ends a stream
router.delete('/:id/end', authenticate, async (req, res) => {
  const stream = await svc.endStream(req.params.id, req.user.id);

  const io = req.app.get('io');
  io?.to(`stream_${stream.id}`).emit('stream_ended', { streamId: stream.id });
  io?.emit('stream_ended', { streamId: stream.id });

  res.json({ success: true, data: stream });
});

// GET /api/streams/:id/token — viewer gets a join token
router.get('/:id/token', authenticate, async (req, res) => {
  const userRes = require('../../config/database').query;
  const uRow = await userRes('SELECT name FROM users WHERE id = $1', [req.user.id]);
  const viewerName = uRow.rows[0]?.name || 'Viewer';

  const result = await svc.getViewerToken(req.params.id, req.user.id, viewerName);

  const io = req.app.get('io');
  io?.to(`stream_${req.params.id}`).emit('viewer_joined', {
    streamId: req.params.id,
    viewerCount: result.stream.viewer_count + 1,
  });

  res.json({ success: true, data: result });
});

// POST /api/streams/:id/leave — viewer leaves a stream
router.post('/:id/leave', authenticate, async (req, res) => {
  await svc.decrementViewer(req.params.id);

  const io = req.app.get('io');
  io?.to(`stream_${req.params.id}`).emit('viewer_left', { streamId: req.params.id });

  res.json({ success: true });
});

module.exports = router;
