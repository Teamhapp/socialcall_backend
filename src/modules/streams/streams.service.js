const { query } = require('../../config/database');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const AGORA_APP_ID  = process.env.AGORA_APP_ID  || '';
const AGORA_APP_CERT = process.env.AGORA_APP_CERTIFICATE || '';

// ── Agora RTC token ────────────────────────────────────────────────────────────
const generateToken = (channelName, uid, canPublish) => {
  if (!AGORA_APP_ID || !AGORA_APP_CERT) {
    throw Object.assign(new Error('Agora credentials not configured on server'), { status: 503 });
  }
  const role     = canPublish ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expireTs = Math.floor(Date.now() / 1000) + 4 * 3600; // 4 h
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID, AGORA_APP_CERT,
    channelName, uid, role, expireTs, expireTs
  );
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

  // Channel name doubles as the Agora channel (≤64 chars, alphanumeric + _)
  const channelName = `stream_${hostId}_${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO live_streams (host_id, room_name, title, status)
     VALUES ($1, $2, $3, 'live') RETURNING *`,
    [hostId, channelName, title || 'Live Stream']
  );

  const uid   = Math.abs(parseInt(hostUserId)) % 4294967295 || 1;
  const token = generateToken(channelName, uid, true);

  return { stream: rows[0], token, channelName, uid, appId: AGORA_APP_ID };
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
    `SELECT ls.*, h.user_id AS host_user_id
       FROM live_streams ls
       JOIN hosts h ON h.id = ls.host_id
      WHERE ls.id = $1 AND ls.status = 'live'`,
    [streamId]
  );
  if (!rows[0]) throw Object.assign(new Error('Stream not found or not live'), { status: 404 });

  await query(
    'UPDATE live_streams SET viewer_count = viewer_count + 1 WHERE id = $1',
    [streamId]
  );

  const channelName = rows[0].room_name;
  const hostUid     = Math.abs(parseInt(rows[0].host_user_id)) % 4294967295 || 1;
  const viewerUid   = Math.abs(parseInt(viewerUserId)) % 4294967295 || 2;
  const token       = generateToken(channelName, viewerUid, false);

  return {
    token,
    channelName,
    uid:     viewerUid,
    hostUid,
    appId:  AGORA_APP_ID,
    stream: rows[0],
  };
};

// ── Viewer leave ──────────────────────────────────────────────────────────────
const decrementViewer = async (streamId) => {
  await query(
    'UPDATE live_streams SET viewer_count = GREATEST(0, viewer_count - 1) WHERE id = $1',
    [streamId]
  );
};

module.exports = { goLive, endStream, listStreams, getViewerToken, decrementViewer };
