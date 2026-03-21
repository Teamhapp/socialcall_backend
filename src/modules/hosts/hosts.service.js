const { query, withTransaction } = require('../../config/database');
const { setex, get, del } = require('../../config/redis');

// ─── List / Search Hosts ──────────────────────────────────────────────────────
const getHosts = async ({ page = 1, limit = 20, language, online, minRate, maxRate, sort = 'rating', search, excludeUserId }) => {
  // Cache only simple first-page queries (no search/price filter/user exclusion)
  const isSimple = !search && !minRate && !maxRate && !excludeUserId && page === 1;
  const cacheKey = `hosts:list:${online || 'all'}:${language || 'any'}:${sort}:${limit}`;
  if (isSimple) {
    try {
      const cached = await get(cacheKey);
      if (cached) return cached;
    } catch (_) {}
  }

  const offset = (page - 1) * limit;
  const params = [];
  const conditions = ['h.is_active = TRUE'];

  if (excludeUserId) {
    params.push(excludeUserId);
    conditions.push(`h.user_id != $${params.length}`);
  }

  if (online === 'true') conditions.push('h.is_online = TRUE');
  if (language) {
    params.push(language);
    conditions.push(`$${params.length} = ANY(h.languages)`);
  }
  if (minRate) {
    params.push(parseFloat(minRate));
    conditions.push(`h.audio_rate_per_min >= $${params.length}`);
  }
  if (maxRate) {
    params.push(parseFloat(maxRate));
    conditions.push(`h.audio_rate_per_min <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`u.name ILIKE $${params.length}`);
  }

  const orderMap = {
    rating: 'h.rating DESC',
    price_asc: 'h.audio_rate_per_min ASC',
    price_desc: 'h.audio_rate_per_min DESC',
    calls: 'h.total_calls DESC',
    newest: 'h.created_at DESC',
  };
  const orderBy = orderMap[sort] || 'h.rating DESC';

  const where = conditions.join(' AND ');

  params.push(limit, offset);
  const dataQuery = `
    SELECT
      h.id, h.user_id, h.bio, h.languages, h.tags,
      h.audio_rate_per_min, h.video_rate_per_min,
      h.rating, h.total_reviews, h.total_calls,
      h.is_online, h.is_verified, h.followers_count,
      u.name, u.avatar
    FROM hosts h
    JOIN users u ON u.id = h.user_id
    WHERE ${where}
    ORDER BY h.is_online DESC, ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const countQuery = `
    SELECT COUNT(*) FROM hosts h
    JOIN users u ON u.id = h.user_id
    WHERE ${where}
  `;

  const [data, count] = await Promise.all([
    query(dataQuery, params),
    query(countQuery, params.slice(0, -2)),
  ]);

  const result = {
    hosts: data.rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: parseInt(count.rows[0].count),
      pages: Math.ceil(count.rows[0].count / limit),
    },
  };

  if (isSimple) {
    setex(cacheKey, 30, result).catch(() => {}); // 30s TTL, non-blocking
  }

  return result;
};

// ─── Get Single Host ─────────────────────────────────────────────────────────
const getHostById = async (hostId, viewerUserId = null) => {
  const { rows } = await query(`
    SELECT
      h.*,
      u.name, u.avatar,
      ${viewerUserId ? `EXISTS(
        SELECT 1 FROM followers f
        WHERE f.host_id = h.id AND f.user_id = $2
      ) AS is_following,` : 'FALSE AS is_following,'}
      COALESCE(
        (SELECT json_agg(r ORDER BY r.created_at DESC) FROM (
          SELECT rv.rating, rv.comment, rv.created_at, u2.name AS reviewer_name
          FROM reviews rv JOIN users u2 ON u2.id = rv.user_id
          WHERE rv.host_id = h.id
          LIMIT 10
        ) r), '[]'
      ) AS recent_reviews
    FROM hosts h
    JOIN users u ON u.id = h.user_id
    WHERE h.id = $1 AND h.is_active = TRUE
  `, viewerUserId ? [hostId, viewerUserId] : [hostId]);

  if (!rows[0]) throw { status: 404, message: 'Host not found' };
  return rows[0];
};

// ─── Get Host by User ID ──────────────────────────────────────────────────────
const getHostByUserId = async (userId) => {
  const { rows } = await query('SELECT * FROM hosts WHERE user_id = $1', [userId]);
  return rows[0] || null;
};

// ─── Create Host Profile ──────────────────────────────────────────────────────
const createHostProfile = async (userId, { bio, languages, tags, audioRate, videoRate }) => {
  return withTransaction(async (client) => {
    // Check if already a host
    const existing = await client.query('SELECT id FROM hosts WHERE user_id = $1', [userId]);
    if (existing.rows[0]) throw { status: 409, message: 'Host profile already exists' };

    // Create host
    const { rows } = await client.query(`
      INSERT INTO hosts (user_id, bio, languages, tags, audio_rate_per_min, video_rate_per_min)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [userId, bio || '', languages || [], tags || [], audioRate || 15, videoRate || 40]);

    // Mark user as host
    await client.query('UPDATE users SET is_host = TRUE WHERE id = $1', [userId]);

    return rows[0];
  });
};

// ─── Update Host Profile ──────────────────────────────────────────────────────
const updateHostProfile = async (userId, updates) => {
  const allowed = ['bio', 'languages', 'tags', 'audio_rate_per_min', 'video_rate_per_min'];
  const fields = [];
  const values = [];
  let idx = 1;

  const fieldMap = {
    bio: 'bio',
    languages: 'languages',
    tags: 'tags',
    audioRate: 'audio_rate_per_min',
    videoRate: 'video_rate_per_min',
  };

  for (const [key, dbField] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) {
      fields.push(`${dbField} = $${idx++}`);
      values.push(updates[key]);
    }
  }

  if (!fields.length) throw { status: 400, message: 'No fields to update' };

  values.push(userId);
  const { rows } = await query(
    `UPDATE hosts SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
};

// ─── Set Online Status ────────────────────────────────────────────────────────
const _hostCacheKeys = [
  'hosts:list:all:any:rating:20',
  'hosts:list:online:any:rating:20',
  'hosts:list:all:any:calls:20',
  'hosts:list:all:any:newest:20',
];

const setOnlineStatus = async (userId, isOnline) => {
  await query('UPDATE hosts SET is_online = $1 WHERE user_id = $2', [isOnline, userId]);
  // Invalidate cached host lists — TTL is 30s so stale data clears soon anyway
  _hostCacheKeys.forEach((k) => del(k).catch(() => {}));
};

// ─── Follow / Unfollow ────────────────────────────────────────────────────────
const toggleFollow = async (userId, hostId) => {
  const existing = await query(
    'SELECT id FROM followers WHERE user_id = $1 AND host_id = $2',
    [userId, hostId]
  );

  if (existing.rows[0]) {
    await query('DELETE FROM followers WHERE user_id = $1 AND host_id = $2', [userId, hostId]);
    await query('UPDATE hosts SET followers_count = followers_count - 1 WHERE id = $1', [hostId]);
    return { following: false };
  } else {
    await query('INSERT INTO followers (user_id, host_id) VALUES ($1, $2)', [userId, hostId]);
    await query('UPDATE hosts SET followers_count = followers_count + 1 WHERE id = $1', [hostId]);
    return { following: true };
  }
};

// ─── Get hosts followed by a user ────────────────────────────────────────────
const getFollowing = async (userId) => {
  const { rows } = await query(`
    SELECT
      h.id, h.user_id, h.bio, h.languages, h.tags,
      h.audio_rate_per_min, h.video_rate_per_min,
      h.rating, h.total_reviews, h.total_calls,
      h.is_online, h.is_verified, h.followers_count,
      u.name, u.avatar
    FROM followers f
    JOIN hosts h ON h.id = f.host_id
    JOIN users u ON u.id = h.user_id
    WHERE f.user_id = $1 AND h.is_active = TRUE
    ORDER BY h.is_online DESC, h.rating DESC
  `, [userId]);
  return rows;
};

// ─── Update host rating after review ─────────────────────────────────────────
const updateHostRating = async (hostId) => {
  await query(`
    UPDATE hosts SET
      rating = (SELECT COALESCE(AVG(rating)::DECIMAL(3,2), 0) FROM reviews WHERE host_id = $1),
      total_reviews = (SELECT COUNT(*) FROM reviews WHERE host_id = $1)
    WHERE id = $1
  `, [hostId]);
};

// ─── Host Analytics ───────────────────────────────────────────────────────────
const getHostAnalytics = async (userId, period = '30d') => {
  const { rows: hostRows } = await query('SELECT id FROM hosts WHERE user_id = $1', [userId]);
  if (!hostRows[0]) throw { status: 404, message: 'Host not found' };
  const hostId = hostRows[0].id;

  const cacheKey = `host:analytics:${hostId}:${period}`;
  try {
    const cached = await get(cacheKey);
    if (cached) return cached;
  } catch (_) {}

  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = `NOW() - INTERVAL '${days} days'`;

  // Summary
  const { rows: sumRows } = await query(`
    SELECT
      COUNT(*) AS total_calls,
      COALESCE(SUM(host_earnings), 0) AS total_earnings,
      COALESCE(SUM(duration_seconds), 0) AS total_seconds,
      COALESCE(AVG(duration_seconds), 0) AS avg_duration_seconds
    FROM calls
    WHERE host_id = $1 AND status = 'ended' AND created_at >= ${since}
  `, [hostId]);

  // Repeat caller rate
  const { rows: repeatRows } = await query(`
    SELECT
      COUNT(DISTINCT user_id) AS unique_callers,
      COUNT(DISTINCT CASE WHEN cnt > 1 THEN user_id END) AS repeat_callers
    FROM (
      SELECT user_id, COUNT(*) AS cnt
      FROM calls WHERE host_id = $1 AND status = 'ended' AND created_at >= ${since}
      GROUP BY user_id
    ) t
  `, [hostId]);

  // Call type breakdown
  const { rows: typeRows } = await query(`
    SELECT
      call_type,
      COUNT(*) AS count,
      COALESCE(SUM(host_earnings), 0) AS earnings
    FROM calls
    WHERE host_id = $1 AND status = 'ended' AND created_at >= ${since}
    GROUP BY call_type
  `, [hostId]);

  // Peak hours
  const { rows: hourRows } = await query(`
    SELECT
      EXTRACT(HOUR FROM started_at)::INTEGER AS hour,
      COUNT(*) AS call_count
    FROM calls
    WHERE host_id = $1 AND status = 'ended' AND started_at IS NOT NULL AND created_at >= ${since}
    GROUP BY hour
    ORDER BY hour
  `, [hostId]);

  // Daily earnings (for chart)
  const { rows: dailyRows } = await query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS call_count,
      COALESCE(SUM(host_earnings), 0) AS earnings
    FROM calls
    WHERE host_id = $1 AND status = 'ended' AND created_at >= ${since}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `, [hostId]);

  // Top 5 callers
  const { rows: topRows } = await query(`
    SELECT
      u.name, u.avatar,
      COUNT(*) AS call_count,
      COALESCE(SUM(c.amount_charged), 0) AS total_spent
    FROM calls c
    JOIN users u ON u.id = c.user_id
    WHERE c.host_id = $1 AND c.status = 'ended' AND c.created_at >= ${since}
    GROUP BY u.id, u.name, u.avatar
    ORDER BY call_count DESC
    LIMIT 5
  `, [hostId]);

  const s = sumRows[0];
  const r = repeatRows[0];
  const uniqueCallers = parseInt(r.unique_callers) || 0;
  const repeatCallers = parseInt(r.repeat_callers) || 0;

  const audioRow = typeRows.find(t => t.call_type === 'audio') || {};
  const videoRow = typeRows.find(t => t.call_type === 'video') || {};

  const result = {
    summary: {
      totalCalls: parseInt(s.total_calls),
      totalEarnings: parseFloat(s.total_earnings).toFixed(2),
      totalMinutes: Math.floor(parseInt(s.total_seconds) / 60),
      avgCallDurationSeconds: Math.floor(parseFloat(s.avg_duration_seconds)),
      uniqueCallers,
      repeatCallers,
      repeatCallerRate: uniqueCallers > 0 ? Math.round((repeatCallers / uniqueCallers) * 100) : 0,
    },
    callTypeBreakdown: {
      audioCalls: parseInt(audioRow.count || 0),
      videoCalls: parseInt(videoRow.count || 0),
      audioEarnings: parseFloat(audioRow.earnings || 0).toFixed(2),
      videoEarnings: parseFloat(videoRow.earnings || 0).toFixed(2),
    },
    peakHours: hourRows.map(h => ({ hour: h.hour, callCount: parseInt(h.call_count) })),
    dailyEarnings: dailyRows.map(d => ({
      date: d.date,
      callCount: parseInt(d.call_count),
      earnings: parseFloat(d.earnings).toFixed(2),
    })),
    topCallers: topRows.map(t => ({
      name: t.name,
      avatar: t.avatar,
      callCount: parseInt(t.call_count),
      totalSpent: parseFloat(t.total_spent).toFixed(2),
    })),
  };

  // Cache for 1 hour
  setex(cacheKey, 3600, result).catch(() => {});

  return result;
};

module.exports = {
  getHosts, getHostById, getHostByUserId,
  createHostProfile, updateHostProfile,
  setOnlineStatus, toggleFollow, updateHostRating, getFollowing,
  getHostAnalytics,
};
