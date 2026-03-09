const { createClient } = require('redis');

let redisClient = null;

const getRedisClient = async () => {
  if (redisClient && redisClient.isOpen) return redisClient;

  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
      connectTimeout: 3000,                              // fail fast if unreachable
      reconnectStrategy: (retries) => {
        if (retries >= 3) return new Error('Redis unavailable after max retries');
        return Math.min(retries * 100, 1000);
      },
    },
  });

  redisClient.on('connect', () => console.log('✅ Redis connected'));
  redisClient.on('error', (err) => console.error('❌ Redis error:', err.message));
  redisClient.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));

  await redisClient.connect();
  return redisClient;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const setex = async (key, seconds, value) => {
  const client = await getRedisClient();
  await client.setEx(key, seconds, typeof value === 'string' ? value : JSON.stringify(value));
};

const get = async (key) => {
  const client = await getRedisClient();
  const value = await client.get(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
};

const del = async (key) => {
  const client = await getRedisClient();
  await client.del(key);
};

const exists = async (key) => {
  const client = await getRedisClient();
  return await client.exists(key);
};

module.exports = { getRedisClient, setex, get, del, exists };
