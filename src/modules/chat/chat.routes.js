const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const svc = require('./chat.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');

// ── Allowed audio MIME types ──────────────────────────────────────────────────
const ALLOWED_AUDIO = [
  'audio/m4a', 'audio/mp4', 'audio/aac',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
];
const audioFilter = (_, file, cb) =>
  ALLOWED_AUDIO.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Only audio files allowed'));

// ── Storage: S3 when env vars present, local disk otherwise ──────────────────
// Set AWS_S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to use S3.
// S3 is required for multi-instance deployments; local disk is single-instance only.
const HAS_S3 = !!(
  process.env.AWS_S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);

let voiceUpload;

if (HAS_S3) {
  const { S3Client } = require('@aws-sdk/client-s3');
  const multerS3    = require('multer-s3');

  const s3 = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  voiceUpload = multer({
    storage: multerS3({
      s3,
      bucket:      process.env.AWS_S3_BUCKET,
      acl:         'public-read',
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.m4a';
        cb(null, `voice/${req.user?.id}_${Date.now()}${ext}`);
      },
    }),
    limits:     { fileSize: 2 * 1024 * 1024 },
    fileFilter: audioFilter,
  });

  logger.info('Voice upload: S3 storage active', { bucket: process.env.AWS_S3_BUCKET });
} else {
  // Local disk fallback — works on a single instance.
  // For multi-instance: set AWS_S3_BUCKET env var to switch to S3 automatically.
  const voiceUploadDir = path.join(__dirname, '..', '..', '..', 'uploads', 'voice');
  if (!fs.existsSync(voiceUploadDir)) fs.mkdirSync(voiceUploadDir, { recursive: true });

  voiceUpload = multer({
    storage: multer.diskStorage({
      destination: (_, __, cb) => cb(null, voiceUploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.m4a';
        cb(null, `voice_${req.user?.id}_${Date.now()}${ext}`);
      },
    }),
    limits:     { fileSize: 2 * 1024 * 1024 },
    fileFilter: audioFilter,
  });

  logger.info('Voice upload: local disk (set AWS_S3_BUCKET for multi-instance S3 storage)');
}

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

    // S3 uploads set req.file.location (public URL); local disk uses filename
    const voiceUrl = req.file.location
      ? req.file.location
      : `${req.protocol}://${req.get('host')}/uploads/voice/${req.file.filename}`;

    const durationSeconds = req.body.duration ? parseInt(req.body.duration) : null;
    const message = await svc.saveVoiceMessage(req.user.id, req.params.userId, voiceUrl, durationSeconds);

    // Emit to receiver's room (works cross-instance via Redis adapter)
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.params.userId}`).emit('new_message', message);
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
