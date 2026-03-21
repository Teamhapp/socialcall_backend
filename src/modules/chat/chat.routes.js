const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const svc = require('./chat.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Multer setup for voice uploads ────────────────────────────────────────────
const voiceUploadDir = path.join(__dirname, '..', '..', '..', 'uploads', 'voice');
if (!fs.existsSync(voiceUploadDir)) fs.mkdirSync(voiceUploadDir, { recursive: true });

const voiceStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, voiceUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.m4a';
    cb(null, `voice_${req.user?.id}_${Date.now()}${ext}`);
  },
});
const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (_, file, cb) => {
    const allowed = ['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/x-m4a'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only audio files allowed'));
  },
});

// GET /api/chat — all conversations
router.get('/', authenticate, async (req, res) => {
  const conversations = await svc.getConversations(req.user.id);
  res.json({ success: true, data: conversations });
});

// GET /api/chat/:userId — messages with a specific user
router.get('/:userId', authenticate, async (req, res) => {
  const messages = await svc.getMessages(req.user.id, req.params.userId, req.query);
  res.json({ success: true, data: messages });
});

// POST /api/chat/:userId — send a message (REST fallback; prefer Socket.IO)
router.post('/:userId', authenticate,
  [
    body('content').notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }),
    body('messageType').optional().isIn(['text', 'gift', 'image']),
    validate,
  ],
  async (req, res) => {
    const message = await svc.saveMessage(req.user.id, req.params.userId, req.body);
    res.status(201).json({ success: true, data: message });
  }
);

// POST /api/chat/:userId/voice — upload and send a voice message
router.post('/:userId/voice',
  authenticate,
  voiceUpload.single('audio'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Audio file is required' });
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const voiceUrl = `${baseUrl}/uploads/voice/${req.file.filename}`;
    const durationSeconds = req.body.duration ? parseInt(req.body.duration) : null;

    const message = await svc.saveVoiceMessage(req.user.id, req.params.userId, voiceUrl, durationSeconds);

    // Emit socket event so receiver sees it in real time
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.userId).emit('new_message', message);
    }

    res.status(201).json({ success: true, data: message });
  }
);

// PATCH /api/chat/:userId/read — mark messages as read
router.patch('/:userId/read', authenticate, async (req, res) => {
  await svc.markAsRead(req.user.id, req.params.userId);
  res.json({ success: true });
});

module.exports = router;
