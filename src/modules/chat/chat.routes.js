const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate } = require('../../middleware/auth');
const svc = require('./chat.service');

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

// PATCH /api/chat/:userId/read — mark messages as read
router.patch('/:userId/read', authenticate, async (req, res) => {
  await svc.markAsRead(req.user.id, req.params.userId);
  res.json({ success: true });
});

module.exports = router;
