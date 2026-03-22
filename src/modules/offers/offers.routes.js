// src/modules/offers/offers.routes.js
// Public endpoint — no auth required (marketing content)
// GET /api/offers → returns currently active offers

const router = require('express').Router();
const { query } = require('../../config/database');

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, title, subtitle, bg_color_hex, icon_emoji,
             cta_label, promo_code, starts_at, ends_at
      FROM   offers
      WHERE  is_active = TRUE
        AND  starts_at <= NOW()
        AND  ends_at   >= NOW()
      ORDER  BY created_at DESC
      LIMIT  20
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    // Table may not exist yet (migration not run) — return empty list
    if (err.message?.includes('does not exist')) {
      return res.json({ success: true, data: [] });
    }
    throw err;
  }
});

module.exports = router;
