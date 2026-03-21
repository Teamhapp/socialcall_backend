const { query } = require('../../config/database');
const notifSvc = require('../notifications/notification.service');

// ─── Submit a report ──────────────────────────────────────────────────────────
const submitReport = async (reporterId, { targetType, targetId, reason, description }) => {
  // Check if already reported
  const existing = await query(
    'SELECT id FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3',
    [reporterId, targetType, targetId]
  );
  if (existing.rows[0]) {
    throw { status: 409, message: 'You have already reported this.' };
  }

  const { rows } = await query(`
    INSERT INTO reports (reporter_id, target_type, target_id, reason, description)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [reporterId, targetType, targetId, reason, description || null]);

  // Auto-flag host after 3+ reports
  if (targetType === 'host') {
    const { rows: countRows } = await query(
      "SELECT COUNT(*) FROM reports WHERE target_type = 'host' AND target_id = $1 AND status IN ('pending', 'actioned')",
      [targetId]
    );
    if (parseInt(countRows[0].count) >= 3) {
      // targetId here is the host's user_id (UUID from Flutter's host.userId)
      // Try flagging by host id first, then by user_id
      await query('UPDATE hosts SET is_flagged = TRUE WHERE id = $1 OR user_id = $1', [targetId]);
    }
  }

  return rows[0];
};

// ─── Admin: list reports ──────────────────────────────────────────────────────
const getReports = async ({ status, targetType, page = 1, limit = 20 }) => {
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }
  if (targetType) {
    params.push(targetType);
    conditions.push(`r.target_type = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(`
    SELECT
      r.*,
      u.name AS reporter_name, u.avatar AS reporter_avatar,
      rv.name AS reviewer_name
    FROM reports r
    JOIN users u ON u.id = r.reporter_id
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    ${where}
    ORDER BY r.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM reports r ${where}`,
    params.slice(0, -2)
  );

  return {
    reports: rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: parseInt(countRows[0].count),
    },
  };
};

// ─── Admin: review a report ───────────────────────────────────────────────────
const reviewReport = async (adminUserId, reportId, { action, adminNote }) => {
  const { rows } = await query('SELECT * FROM reports WHERE id = $1', [reportId]);
  if (!rows[0]) throw { status: 404, message: 'Report not found' };

  const report = rows[0];
  let newStatus;

  if (action === 'dismiss') {
    newStatus = 'dismissed';
  } else if (action === 'warn' || action === 'suspend') {
    newStatus = 'actioned';
  } else {
    throw { status: 400, message: 'Invalid action. Use dismiss, warn, or suspend.' };
  }

  await query(`
    UPDATE reports
    SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW()
    WHERE id = $4
  `, [newStatus, adminNote || null, adminUserId, reportId]);

  // Send FCM to reported user if target is host
  if (report.target_type === 'host' && action !== 'dismiss') {
    // Get host's user_id
    const hostRes = await query(
      'SELECT user_id FROM hosts WHERE id = $1 OR user_id = $1',
      [report.target_id]
    );
    if (hostRes.rows[0]) {
      const hostUserId = hostRes.rows[0].user_id;

      if (action === 'warn') {
        await notifSvc.sendToUser(hostUserId, {
          title: 'Account Warning',
          body: 'Your account has received a warning due to a user report. Please review our community guidelines.',
          data: { type: 'account_warning' },
        });
      } else if (action === 'suspend') {
        // Suspend the user
        await query('UPDATE users SET is_active = FALSE WHERE id = $1', [hostUserId]);
        await query('UPDATE hosts SET is_online = FALSE WHERE user_id = $1', [hostUserId]);
        await notifSvc.sendToUser(hostUserId, {
          title: 'Account Suspended',
          body: 'Your account has been suspended due to multiple violations. Contact support to appeal.',
          data: { type: 'account_suspended' },
        });
      }
    }
  }

  return { success: true, action, reportId };
};

module.exports = { submitReport, getReports, reviewReport };
