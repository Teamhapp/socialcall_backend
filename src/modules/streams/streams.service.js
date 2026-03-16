const { query } = require('../../config/database');
const { AccessToken } = require('livekit-server-sdk');

const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

// ── Token generator ───────────────────────────────────────────────────────────
const generateToken = (roomName, identity, name, canPublish) => {
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: 4 * 60 * 60, // 4 hours
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true });
  return token.toJwt();
};

// ── Go live ───────────────────────────────────────────────────────────────────
const goLive = async (hostUserId, title) => {
  const hostRes = await query('SELECT id FROM hosts WHERE user_id = $1', [hostUserId]);
  if (!hostRes.rows[0]) throw Object.assign(new Error('Host profile not found'), { status: 404 });
  const hostId = hostRes.rows[0].id;

  // End any previous live stream from this host
  await query(
    "UPDATE live_streams SET status = 'ended', ended_at = NOW() WHERE host_id = $1 AND status = 'live'",
    [hostId]
  );

  const roomName = `stream_${hostId}_${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO live_streams (host_id, room_name, title, status)
     VALUES ($1, $2, $3, 'live') RETURNING *`,
    [hostId, roomName, title || 'Live Stream']
  );

  const userRes = await query('SELECT name FROM users WHERE id = $1', [hostUserId]);
  const hostName = userRes.rows[0]?.name || 'Host';
  const token = await generateToken(roomName, `host_${hostUserId}`, hostName, true);

  return { stream: rows[0], token, livekitUrl: process.env.LIVEKIT_URL };
};

// ── End stream ────────────────────────────────────────────────────────────────
const endStream = async (streamId, hostUserId) => {
  const hostRes = await query('SELECT id FROM hosts WHERE user_id = $1', [hostUserId]);
  if (!hostRes.rows[0]) throw Object.assign(new Error('Host profile not found'), { status: 404 });

  const { rows } = await query(
    `UPDATE live_streams SET status = 'ended', ended_at = NOW()
     WHERE id = $1 AND host_id = $2 AND status = 'live' RETURNING *`,
    [streamId, hostRes.rows[0].id]
  );
  if (!rows[0]) throw Object.assign(new Error('Stream not found or already ended'), { status: 404 });
  return rows[0];
};

// ── List active streams ────────────────────────────────────────────────────────
const listStreams = async () => {
  const { rows } = await query(`
    SELECT ls.*, h.user_id AS host_user_id, u.name AS host_name, u.avatar AS host_avatar
    FROM live_streams ls
    JOIN hosts h ON h.id = ls.host_id
    JOIN users u ON u.id = h.user_id
    WHERE ls.status = 'live'
    ORDER BY ls.viewer_count DESC, ls.started_at DESC
    LIMIT 50
  `);
  return rows;
};

// ── Viewer join token ──────────────────────────────────────────────────────────
const getViewerToken = async (streamId, viewerUserId, viewerName) => {
  const { rows } = await query(
    "SELECT * FROM live_streams WHERE id = $1 AND status = 'live'",
    [streamId]
  );
  if (!rows[0]) throw Object.assign(new Error('Stream not found or not live'), { status: 404 });

  await query(
    'UPDATE live_streams SET viewer_count = viewer_count + 1 WHERE id = $1',
    [streamId]
  );

  const token = await generateToken(rows[0].room_name, `viewer_${viewerUserId}`, viewerName, false);
  return { token, roomName: rows[0].room_name, livekitUrl: process.env.LIVEKIT_URL, stream: rows[0] };
};

// ── Viewer leave ──────────────────────────────────────────────────────────────
const decrementViewer = async (streamId) => {
  await query(
    'UPDATE live_streams SET viewer_count = GREATEST(0, viewer_count - 1) WHERE id = $1',
    [streamId]
  );
};

module.exports = { goLive, endStream, listStreams, getViewerToken, decrementViewer };
