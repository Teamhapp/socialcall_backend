const { query } = require('../../config/database');

// ─── Get conversations (inbox) ────────────────────────────────────────────────
const getConversations = async (userId) => {
  const { rows } = await query(`
    SELECT DISTINCT ON (other_user_id)
      other_user_id,
      u.name AS other_name,
      u.avatar AS other_avatar,
      m.content AS last_message,
      m.created_at AS last_message_at,
      m.is_read,
      (m.sender_id = $1) AS is_sent_by_me,
      (SELECT COUNT(*) FROM messages m2
       WHERE m2.sender_id = other_user_id AND m2.receiver_id = $1 AND m2.is_read = FALSE
      ) AS unread_count,
      h.is_online,
      h.id AS host_id,
      h.audio_rate_per_min,
      h.video_rate_per_min
    FROM (
      SELECT *,
        CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_user_id
      FROM messages
      WHERE sender_id = $1 OR receiver_id = $1
    ) m
    JOIN users u ON u.id = m.other_user_id
    LEFT JOIN hosts h ON h.user_id = u.id
    ORDER BY other_user_id, m.created_at DESC
  `, [userId]);

  return rows;
};

// ─── Get messages in a conversation ──────────────────────────────────────────
const getMessages = async (userId, otherUserId, { page = 1, limit = 50 }) => {
  const offset = (page - 1) * limit;

  // Mark messages as read
  await query(`
    UPDATE messages SET is_read = TRUE
    WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE
  `, [otherUserId, userId]);

  const { rows } = await query(`
    SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = $1 AND m.receiver_id = $2)
       OR (m.sender_id = $2 AND m.receiver_id = $1)
    ORDER BY m.created_at DESC
    LIMIT $3 OFFSET $4
  `, [userId, otherUserId, limit, offset]);

  return rows.reverse(); // chronological order
};

// ─── Save a message ───────────────────────────────────────────────────────────
const saveMessage = async (senderId, receiverId, { content, messageType = 'text', giftId }) => {
  // Check if users have interacted (call completed)
  if (messageType === 'text') {
    const hasInteracted = await query(`
      SELECT 1 FROM calls
      WHERE (
        (user_id = $1 AND host_id IN (SELECT id FROM hosts WHERE user_id = $2))
        OR (user_id = $2 AND host_id IN (SELECT id FROM hosts WHERE user_id = $1))
      )
      AND status = 'ended'
      LIMIT 1
    `, [senderId, receiverId]);

    if (!hasInteracted.rows[0]) {
      throw { status: 403, message: 'Complete a call first to unlock chat' };
    }
  }

  const { rows } = await query(`
    INSERT INTO messages (sender_id, receiver_id, content, message_type, gift_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [senderId, receiverId, content, messageType, giftId || null]);

  return rows[0];
};

// ─── Mark messages read ───────────────────────────────────────────────────────
const markAsRead = async (userId, senderId) => {
  await query(`
    UPDATE messages SET is_read = TRUE
    WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE
  `, [senderId, userId]);
};

module.exports = { getConversations, getMessages, saveMessage, markAsRead };
