const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../../middleware/errorHandler');
const { authenticate, requireHost, optionalAuth } = require('../../middleware/auth');
const svc = require('./hosts.service');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query: dbQuery } = require('../../config/database');
const { notifyFollowersOnline } = require('../../socket/socket');

// ── Multer setup for KYC uploads ──────────────────────────────────────────────
const kycUploadDir = path.join(__dirname, '..', '..', '..', 'uploads', 'kyc');
if (!fs.existsSync(kycUploadDir)) fs.mkdirSync(kycUploadDir, { recursive: true });

const kycStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, kycUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `kyc_${req.user?.id}_${file.fieldname}_${Date.now()}${ext}`);
  },
});
const kycUpload = multer({
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max per file
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only image files allowed'));
  },
});

// GET /api/hosts — list / search hosts
router.get('/', optionalAuth, async (req, res) => {
  const result = await svc.getHosts(req.query);
  res.json({ success: true, data: result });
});

// GET /api/hosts/me — own host profile + earnings (hosts only)
router.get('/me', authenticate, requireHost, async (req, res) => {
  const host = await svc.getHostByUserId(req.user.id);
  if (!host) return res.status(404).json({ success: false, message: 'Host profile not found' });
  res.json({ success: true, data: host });
});

// GET /api/hosts/following — hosts the current user follows
router.get('/following', authenticate, async (req, res) => {
  const hosts = await svc.getFollowing(req.user.id);
  res.json({ success: true, data: hosts });
});

// GET /api/hosts/kyc — get own KYC status
router.get('/kyc', authenticate, requireHost, async (req, res) => {
  try {
    // Get host id
    const hostRes = await dbQuery('SELECT id FROM hosts WHERE user_id = $1', [req.user.id]);
    if (!hostRes.rows[0]) return res.status(404).json({ success: false, message: 'Host profile not found' });
    const hostId = hostRes.rows[0].id;

    const { rows } = await dbQuery(
      'SELECT * FROM kyc_documents WHERE host_id = $1',
      [hostId]
    );
    const kycStatusRes = await dbQuery('SELECT kyc_status FROM hosts WHERE id = $1', [hostId]);
    res.json({
      success: true,
      data: {
        kyc_status: kycStatusRes.rows[0]?.kyc_status || 'not_submitted',
        submission: rows[0] || null,
      },
    });
  } catch {
    res.json({ success: true, data: { kyc_status: 'not_submitted', submission: null } });
  }
});

// POST /api/hosts/kyc — submit KYC documents
router.post(
  '/kyc',
  authenticate,
  requireHost,
  kycUpload.fields([
    { name: 'front', maxCount: 1 },
    { name: 'back', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]),
  async (req, res) => {
    const { document_type = 'aadhaar' } = req.body || {};
    const files = req.files || {};

    if (!files.front || files.front.length === 0) {
      return res.status(400).json({ success: false, message: 'Front image of document is required' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const frontUrl  = `${baseUrl}/uploads/kyc/${files.front[0].filename}`;
    const backUrl   = files.back?.[0]   ? `${baseUrl}/uploads/kyc/${files.back[0].filename}`   : null;
    const selfieUrl = files.selfie?.[0] ? `${baseUrl}/uploads/kyc/${files.selfie[0].filename}` : null;

    // Get host id
    const hostRes = await dbQuery('SELECT id FROM hosts WHERE user_id = $1', [req.user.id]);
    if (!hostRes.rows[0]) return res.status(404).json({ success: false, message: 'Host profile not found' });
    const hostId = hostRes.rows[0].id;

    // Upsert KYC document (one submission per host)
    const { rows } = await dbQuery(`
      INSERT INTO kyc_documents (host_id, document_type, front_url, back_url, selfie_url, status, submitted_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      ON CONFLICT (host_id) DO UPDATE SET
        document_type = EXCLUDED.document_type,
        front_url     = EXCLUDED.front_url,
        back_url      = EXCLUDED.back_url,
        selfie_url    = EXCLUDED.selfie_url,
        status        = 'pending',
        rejection_reason = NULL,
        submitted_at  = NOW()
      RETURNING *
    `, [hostId, document_type, frontUrl, backUrl, selfieUrl]);

    // Update host kyc_status
    await dbQuery('UPDATE hosts SET kyc_status = $1 WHERE id = $2', ['pending', hostId]);

    res.json({ success: true, message: 'KYC submitted for review. We\'ll notify you within 24 hours.', data: rows[0] });
  }
);

// GET /api/hosts/payouts — host's own payout history
router.get('/payouts', authenticate, requireHost, async (req, res) => {
  const hostRes = await dbQuery('SELECT id FROM hosts WHERE user_id = $1', [req.user.id]);
  if (!hostRes.rows[0]) return res.status(404).json({ success: false, message: 'Host profile not found' });

  const { rows } = await dbQuery(
    `SELECT id, amount, status, notes, requested_at, processed_at, reference_id
     FROM payouts WHERE host_id = $1 ORDER BY requested_at DESC LIMIT 20`,
    [hostRes.rows[0].id]
  );
  res.json({ success: true, data: rows });
});

// POST /api/hosts/payout — request a payout of pending earnings
router.post('/payout', authenticate, requireHost, async (req, res) => {
  const hostRes = await dbQuery(
    'SELECT id, pending_earnings, is_verified FROM hosts WHERE user_id = $1',
    [req.user.id]
  );
  if (!hostRes.rows[0]) {
    return res.status(404).json({ success: false, message: 'Host profile not found' });
  }

  const { id: hostId, pending_earnings, is_verified } = hostRes.rows[0];
  const amount = parseFloat(pending_earnings);

  // KYC gate — only verified hosts can withdraw
  if (!is_verified) {
    return res.status(403).json({
      success: false,
      message: 'Complete KYC verification to enable payouts.',
    });
  }

  if (amount < 500) {
    return res.status(400).json({
      success: false,
      message: `Minimum payout is ₹500. Your current pending balance is ₹${amount.toFixed(2)}.`,
    });
  }

  // Prevent duplicate pending payout request
  const existingRes = await dbQuery(
    "SELECT id FROM payouts WHERE host_id = $1 AND status = 'pending'",
    [hostId]
  );
  if (existingRes.rows[0]) {
    return res.status(409).json({
      success: false,
      message: 'You already have a pending payout request being processed.',
    });
  }

  // Validate payment details
  const { paymentMethod, paymentDetails } = req.body || {};
  if (!paymentMethod || !paymentDetails) {
    return res.status(400).json({ success: false, message: 'Payment method and details are required.' });
  }
  if (!['upi', 'bank'].includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: 'Invalid payment method. Use "upi" or "bank".' });
  }
  if (paymentMethod === 'upi' && !paymentDetails.upiId) {
    return res.status(400).json({ success: false, message: 'UPI ID is required.' });
  }
  if (paymentMethod === 'bank' && (!paymentDetails.accountNumber || !paymentDetails.ifsc || !paymentDetails.accountHolder)) {
    return res.status(400).json({ success: false, message: 'Account number, IFSC code, and account holder name are required.' });
  }

  // Store payment details in notes as JSON (admin reads this when processing)
  const notes = JSON.stringify({ paymentMethod, ...paymentDetails });

  await dbQuery(
    'INSERT INTO payouts (host_id, amount, status, notes, requested_at) VALUES ($1, $2, $3, $4, NOW())',
    [hostId, amount, 'pending', notes]
  );

  res.json({
    success: true,
    message: `Payout of ₹${amount.toFixed(2)} requested! We'll process it in 3–5 business days.`,
  });
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

    // Immediately go online — host is live as soon as they register
    await svc.setOnlineStatus(req.user.id, true);
    const io = req.app.get('io');
    if (io) {
      io.emit('host_online', { userId: req.user.id });
      notifyFollowersOnline(io, req.user.id).catch(() => {});
    }

    res.status(201).json({ success: true, message: 'Host profile created', data: { ...host, is_online: true } });
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
    const io = req.app.get('io');
    await svc.setOnlineStatus(req.user.id, req.body.isOnline);

    // Broadcast status change to all connected clients
    io?.emit('host_status_changed', { userId: req.user.id, isOnline: req.body.isOnline });

    // Notify followers when host goes online (fire-and-forget)
    if (req.body.isOnline) {
      notifyFollowersOnline(io, req.user.id).catch(() => {});
    }

    res.json({ success: true, message: `Status set to ${req.body.isOnline ? 'online' : 'offline'}` });
  }
);

// POST /api/hosts/:id/follow — follow / unfollow
router.post('/:id/follow', authenticate, async (req, res) => {
  const result = await svc.toggleFollow(req.user.id, req.params.id);
  res.json({ success: true, ...result });
});

module.exports = router;
