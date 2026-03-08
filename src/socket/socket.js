const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { setex, get, del } = require('../config/redis');
const chatService = require('../modules/chat/chat.service');
const callsService = require('../modules/calls/calls.service');
const notifService = require('../modules/notifications/notification.service');
const logger = require('../config/logger');

// Track online users: userId → socketId
const onlineUsers = new Map();

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
          agoraToken: result.agoraToken,
        });

        ack?.({ success: true, ...result });
      } catch (err) {
        ack?.({ error: err.message });
      }
    });

    // Host rejects call
    socket.on('call_rejected', async (data) => {
      const { callId } = data;
      await query(`UPDATE calls SET status = 'failed' WHERE id = $1`, [callId]);
      const callRes = await query('SELECT user_id FROM calls WHERE id = $1', [callId]);
      const callerId = callRes.rows[0]?.user_id;
      io.to(`user:${callerId}`).emit('call_rejected', { callId });
    });

    // End call
    socket.on('call_ended', async (data, ack) => {
      try {
        const { callId } = data;
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

      logger.info('Socket disconnected', { userId, socketId: socket.id });
    });
  });

  return io;
};

const getOnlineUsers = () => onlineUsers;

module.exports = { initSocket, getOnlineUsers };
