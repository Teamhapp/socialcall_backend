const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { setex, get, del } = require('../config/redis');
const chatService = require('../modules/chat/chat.service');
const callsService = require('../modules/calls/calls.service');
const notifService = require('../modules/notifications/notification.service');
const logger = require('../config/logger');

// Track online users: userId → socketId
const onlineUsers = new Map();

// ─── Notify followers that a host just came online (called by socket + REST) ──
// Uses a 5-minute Redis cooldown so rapid reconnects don't spam followers.
async function notifyFollowersOnline(io, hostUserId) {
  const cooldownKey = `host_online_notified:${hostUserId}`;
  if (await get(cooldownKey)) return;

  const hostRes = await query(
    `SELECT h.id, u.name FROM hosts h JOIN users u ON u.id = h.user_id WHERE h.user_id = $1`,
    [hostUserId]
  );
  const host = hostRes.rows[0];
  if (!host) return;

  const followersRes = await query(
    'SELECT user_id FROM followers WHERE host_id = $1', [host.id]
  );
  const followerIds = followersRes.rows.map(r => r.user_id);
  if (!followerIds.length) return;

  // Push to followers who are offline; emit socket event to online followers.
  const offlineIds = followerIds.filter(id => !onlineUsers.has(id));
  if (offlineIds.length) {
    await notifService.sendToMultiple(offlineIds, {
      title: `💜 ${host.name} is now online!`,
      body: 'Tap to call now',
      data: { type: 'host_online', hostId: host.id, hostName: host.name },
    });
  }

  for (const uid of followerIds) {
    if (onlineUsers.has(uid)) {
      io.to(`user:${uid}`).emit('followed_host_online', {
        hostId: host.id, hostName: host.name,
      });
    }
  }

  await setex(cooldownKey, 300, '1');
}

// ─── Per-call server-side wallet watch ───────────────────────────────────────
// Prevents calls from running past wallet balance even if Flutter client dies.
const callCheckIntervals = new Map();

function startWalletCheck(io, callId, callerId, ratePerMin) {
  if (callCheckIntervals.has(callId)) return;
  const startedAt = Date.now();
  const intervalId = setInterval(async () => {
    try {
      const { rows } = await query(
        'SELECT wallet_balance FROM users WHERE id = $1', [callerId]
      );
      const balance    = parseFloat(rows[0]?.wallet_balance || 0);
      const elapsedMin = (Date.now() - startedAt) / 60000;
      const cost       = elapsedMin * ratePerMin;
      const remaining  = balance - cost;
      const minsLeft   = remaining / ratePerMin;

      if (minsLeft <= 0) {
        // Wallet depleted — force-end the call
        clearInterval(intervalId);
        callCheckIntervals.delete(callId);
        try {
          const result = await callsService.endCall(callId, callerId);
          const callRes = await query(
            'SELECT user_id, host_id FROM calls WHERE id = $1', [callId]
          );
          const call = callRes.rows[0];
          if (call) {
            const hostRes = await query(
              'SELECT user_id FROM hosts WHERE id = $1', [call.host_id]
            );
            const hostUserId = hostRes.rows[0]?.user_id;
            io.to(`user:${call.user_id}`).to(`user:${hostUserId}`)
              .emit('call_summary', { callId, ...result, autoEnded: true });
          }
        } catch (err) {
          logger.error('Auto-end call failed', { callId, err: err.message });
        }
      } else if (minsLeft < 1) {
        // Under 1 minute left — warn the caller
        io.to(`user:${callerId}`).emit('wallet_low_warning', {
          callId, minsLeft: minsLeft.toFixed(1),
        });
      }
    } catch (err) {
      logger.error('Wallet check error', { callId, err: err.message });
    }
  }, 30000); // check every 30 s
  callCheckIntervals.set(callId, { intervalId, callerId, ratePerMin, startedAt });
}

function stopWalletCheck(callId) {
  const entry = callCheckIntervals.get(callId);
  if (entry) {
    clearInterval(entry.intervalId);
    callCheckIntervals.delete(callId);
  }
}

// Batch last_seen updates — flush every 30s instead of on every event
const _lastSeenPending = new Set();
setInterval(() => {
  if (_lastSeenPending.size === 0) return;
  const ids = [..._lastSeenPending];
  _lastSeenPending.clear();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  query(`UPDATE users SET last_seen_at = NOW() WHERE id IN (${placeholders})`, ids)
    .catch(() => {});
}, 30000);

const initSocket = (io) => {

  // ─── Auth middleware ──────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await query('SELECT id, name, is_host FROM users WHERE id = $1', [decoded.userId]);
      if (!rows[0]) return next(new Error('User not found'));

      socket.userId = rows[0].id;
      socket.userName = rows[0].name;
      socket.isHost = rows[0].is_host;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ─── Connection ───────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const { userId } = socket;
    logger.info('Socket connected', { userId, socketId: socket.id });

    // Track online
    onlineUsers.set(userId, socket.id);
    socket.join(`user:${userId}`);

    // Queue last_seen update (batched every 30s — non-blocking)
    _lastSeenPending.add(userId);

    // If host — go online (fire-and-forget, don't block connection)
    if (socket.isHost) {
      query('UPDATE hosts SET is_online = TRUE WHERE user_id = $1', [userId]).catch(() => {});
      socket.join('hosts');
      socket.broadcast.emit('host_online', { userId });
      // Notify followers (5-min cooldown prevents spam on rapid reconnects)
      notifyFollowersOnline(io, userId).catch(() => {});
    }

    // ─── CHAT EVENTS ────────────────────────────────────────────────────

    // Send message
    socket.on('send_message', async (data, ack) => {
      try {
        const { receiverId, content, messageType = 'text', giftId } = data;
        if (!receiverId || !content) return ack?.({ error: 'Missing receiverId or content' });

        const message = await chatService.saveMessage(userId, receiverId, { content, messageType, giftId });

        // Emit to receiver if online
        io.to(`user:${receiverId}`).emit('new_message', {
          ...message,
          senderName: socket.userName,
        });

        ack?.({ success: true, message });

        // Push notification if receiver is offline
        if (!onlineUsers.has(receiverId)) {
          await notifService.sendToUser(receiverId, {
            title: socket.userName,
            body: messageType === 'gift' ? `${socket.userName} sent you a gift 🎁` : content.slice(0, 80),
            data: { type: 'message', senderId: userId },
          }).catch(() => {});
        }
      } catch (err) {
        ack?.({ error: err.message || 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('typing', ({ receiverId, isTyping }) => {
      io.to(`user:${receiverId}`).emit('typing', { senderId: userId, isTyping });
    });

    // Mark messages as read
    socket.on('mark_read', async ({ senderId }) => {
      await chatService.markAsRead(userId, senderId);
      io.to(`user:${senderId}`).emit('messages_read', { readBy: userId });
    });

    // ─── CALL EVENTS ──────────────────────────────────────────────────────

    // Incoming call notification to host
    socket.on('call_request', async (data, ack) => {
      try {
        const { hostId, callType } = data;
        const result = await callsService.initiateCall(userId, hostId, callType || 'audio');

        // Notify host via socket
        const hostRes = await query('SELECT user_id FROM hosts WHERE id = $1', [hostId]);
        const hostUserId = hostRes.rows[0]?.user_id;

        if (hostUserId && onlineUsers.has(hostUserId)) {
          io.to(`user:${hostUserId}`).emit('incoming_call', {
            callId: result.callId,
            callType,
            channelName: result.channelName,
            caller: { id: userId, name: socket.userName },
          });
        } else {
          // Push notification to host
          await notifService.sendToUser(hostUserId, {
            title: '📞 Incoming Call!',
            body: `${socket.userName} is calling you`,
            data: { type: 'call', callId: result.callId, callType },
          }).catch(() => {});
        }

        ack?.({ success: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    // Host accepts call
    socket.on('call_accepted', async (data, ack) => {
      try {
        const { callId } = data;
        const result = await callsService.acceptCall(callId, userId);

        // Notify caller
        const callRes = await query('SELECT user_id FROM calls WHERE id = $1', [callId]);
        const callerId = callRes.rows[0]?.user_id;
        io.to(`user:${callerId}`).emit('call_connected', {
          callId,
          channelName: result.channelName,
        });

        // Start server-side wallet watch — auto-ends call if balance runs out
        const cached = await get(`call:${callId}`);
        if (cached?.ratePerMin && callerId) {
          startWalletCheck(io, callId, callerId, cached.ratePerMin);
        }

        ack?.({ success: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    // Host rejects call
    socket.on('call_rejected', async (data) => {
      const { callId } = data;
      await query(`UPDATE calls SET status = 'failed' WHERE id = $1`, [callId]);
      await del(`call:${callId}`); // clean up Redis cache
      const callRes = await query('SELECT user_id FROM calls WHERE id = $1', [callId]);
      const callerId = callRes.rows[0]?.user_id;
      io.to(`user:${callerId}`).emit('call_rejected', { callId });
    });

    // End call
    socket.on('call_ended', async (data, ack) => {
      try {
        const { callId } = data;
        stopWalletCheck(callId); // cancel server-side wallet interval

        const result = await callsService.endCall(callId, userId);

        // Notify both parties
        const callRes = await query('SELECT user_id, host_id FROM calls WHERE id = $1', [callId]);
        const call = callRes.rows[0];
        if (call) {
          const hostRes = await query('SELECT user_id FROM hosts WHERE id = $1', [call.host_id]);
          const hostUserId = hostRes.rows[0]?.user_id;
          io.to(`user:${call.user_id}`).to(`user:${hostUserId}`).emit('call_summary', {
            callId,
            ...result,
          });
          // If call was never connected (ring-timeout / cancelled before answer)
          // tell the host so their incoming-call overlay dismisses.
          if (result.durationSeconds === 0 && hostUserId) {
            io.to(`user:${hostUserId}`).emit('call_cancelled', { callId });
          }
        }

        ack?.({ success: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    // Wallet low — during call
    socket.on('wallet_low_warning', ({ callId, balance }) => {
      logger.info('Wallet low during call', { userId, callId, balance });
    });

    // ─── WEBRTC SIGNALING ────────────────────────────────────────────────
    // These events are relayed to the other party in the call.
    // The server looks up both participants from callId and forwards.

    const getOtherParty = async (callId) => {
      const { rows } = await query(
        `SELECT c.user_id AS caller_id, h.user_id AS host_user_id
           FROM calls c JOIN hosts h ON h.id = c.host_id
          WHERE c.id = $1`, [callId]
      );
      if (!rows[0]) return null;
      return userId === rows[0].caller_id
        ? rows[0].host_user_id
        : rows[0].caller_id;
    };

    // BUG 1 FIX: Host emits webrtc_ready once its listeners are live.
    // Server relays it to the caller so the caller knows it's safe to send the offer.
    socket.on('webrtc_ready', async ({ callId }) => {
      const targetId = await getOtherParty(callId).catch(() => null);
      if (targetId) io.to(`user:${targetId}`).emit('webrtc_ready', { callId });
    });

    socket.on('webrtc_offer', async ({ callId, sdp }) => {
      const targetId = await getOtherParty(callId).catch(() => null);
      if (targetId) io.to(`user:${targetId}`).emit('webrtc_offer', { callId, sdp });
    });

    socket.on('webrtc_answer', async ({ callId, sdp }) => {
      const targetId = await getOtherParty(callId).catch(() => null);
      if (targetId) io.to(`user:${targetId}`).emit('webrtc_answer', { callId, sdp });
    });

    socket.on('webrtc_ice_candidate', async ({ callId, candidate }) => {
      const targetId = await getOtherParty(callId).catch(() => null);
      if (targetId) io.to(`user:${targetId}`).emit('webrtc_ice_candidate', { callId, candidate });
    });

    // ─── DISCONNECT ───────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      onlineUsers.delete(userId);
      _lastSeenPending.add(userId); // Batched — non-blocking

      if (socket.isHost) {
        query('UPDATE hosts SET is_online = FALSE WHERE user_id = $1', [userId]).catch(() => {});
        socket.broadcast.emit('host_offline', { userId });
      }

      // Clean up any active wallet checks where this user was the caller
      for (const [cid, entry] of callCheckIntervals.entries()) {
        if (entry.callerId === userId) stopWalletCheck(cid);
      }

      // Auto-end any active calls involving this user (as caller OR as host).
      // Prevents calls from hanging forever when a party loses internet.
      try {
        const activeRes = await query(`
          SELECT c.id AS call_id, c.user_id AS caller_id, h.user_id AS host_user_id
          FROM calls c
          JOIN hosts h ON h.id = c.host_id
          WHERE c.status IN ('ringing', 'connected')
            AND (c.user_id = $1 OR h.user_id = $1)
        `, [userId]);

        for (const row of activeRes.rows) {
          try {
            stopWalletCheck(row.call_id);
            const result = await callsService.endCall(row.call_id, userId);
            io.to(`user:${row.caller_id}`).to(`user:${row.host_user_id}`)
              .emit('call_summary', { callId: row.call_id, ...result, autoEnded: true });
          } catch (e) {
            logger.error('Auto-end on disconnect failed', { callId: row.call_id, err: e.message });
          }
        }
      } catch (err) {
        logger.error('Disconnect call cleanup error', { userId, err: err.message });
      }

      logger.info('Socket disconnected', { userId, socketId: socket.id });
    });
  });

  return io;
};

const getOnlineUsers = () => onlineUsers;

module.exports = { initSocket, getOnlineUsers, startWalletCheck, stopWalletCheck, notifyFollowersOnline };
