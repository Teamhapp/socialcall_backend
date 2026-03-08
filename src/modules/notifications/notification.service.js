const { query } = require('../../config/database');
const logger = require('../../config/logger');

let firebaseAdmin = null;

// ─── Init Firebase Admin ──────────────────────────────────────────────────────
const initFirebase = () => {
  if (firebaseAdmin) return firebaseAdmin;
  if (!process.env.FIREBASE_PROJECT_ID) {
    logger.warn('Firebase not configured — push notifications disabled');
    return null;
  }
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
    }
    firebaseAdmin = admin;
    return admin;
  } catch (err) {
    logger.error('Firebase init failed', { error: err.message });
    return null;
  }
};

// ─── Send to single user ──────────────────────────────────────────────────────
const sendToUser = async (userId, { title, body, data = {} }) => {
  const admin = initFirebase();
  if (!admin) return;

  const { rows } = await query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
  const token = rows[0]?.fcm_token;
  if (!token) return;

  return sendToToken(token, { title, body, data });
};

// ─── Send to FCM token ────────────────────────────────────────────────────────
const sendToToken = async (token, { title, body, data = {}, imageUrl }) => {
  const admin = initFirebase();
  if (!admin) return;

  try {
    const message = {
      token,
      notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          priority: 'high',
          channelId: 'socialcall_default',
        },
        priority: 'high',
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
      },
    };

    const response = await admin.messaging().send(message);
    logger.debug('FCM sent', { messageId: response });
    return response;
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      // Token expired — clear it
      await query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [token]);
    }
    logger.error('FCM send failed', { error: err.message, code: err.code });
  }
};

// ─── Send to multiple users ───────────────────────────────────────────────────
const sendToMultiple = async (userIds, notification) => {
  const admin = initFirebase();
  if (!admin || !userIds.length) return;

  const { rows } = await query(
    'SELECT fcm_token FROM users WHERE id = ANY($1) AND fcm_token IS NOT NULL',
    [userIds]
  );

  const tokens = rows.map(r => r.fcm_token);
  if (!tokens.length) return;

  const messages = tokens.map(token => ({
    token,
    notification: { title: notification.title, body: notification.body },
    data: Object.fromEntries(
      Object.entries(notification.data || {}).map(([k, v]) => [k, String(v)])
    ),
  }));

  try {
    await admin.messaging().sendEach(messages);
  } catch (err) {
    logger.error('FCM batch send failed', { error: err.message });
  }
};

// ─── Save FCM token ───────────────────────────────────────────────────────────
const saveToken = async (userId, fcmToken) => {
  await query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcmToken, userId]);
};

module.exports = { sendToUser, sendToToken, sendToMultiple, saveToken };
