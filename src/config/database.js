const { Pool } = require('pg');
const logger = require('./logger');

// Support both DATABASE_URL (Render/Supabase/Railway) and individual env vars (local)
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },  // required for Supabase/Render
      max: parseInt(process.env.DB_POOL_MAX) || 50,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    }
  : {
      host:     process.env.DB_HOST || 'localhost',
      port:     parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'socialcall_db',
      user:     process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.DB_POOL_MAX) || 50,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    };

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  logger.info('PostgreSQL connected');
});

pool.on('error', (err) => {
  logger.error('PostgreSQL error: ' + err.message);
});

// Helper: run a query
const query = (text, params) => pool.query(text, params);

// Helper: get a client for transactions
const getClient = () => pool.connect();

// Helper: run a transaction
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { pool, query, getClient, withTransaction };
