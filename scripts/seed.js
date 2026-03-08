#!/usr/bin/env node
/**
 * Database seeder — inserts demo data for testing
 * Usage:  node scripts/seed.js
 *         npm run seed
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host:     process.env.DB_HOST || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'socialcall_db',
        user:     process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
      }
);

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...\n');

    // ── Gifts ───────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO gifts (name, emoji, price, is_active) VALUES
        ('Rose',        '🌹',  5.00,  TRUE),
        ('Heart',       '❤️', 10.00,  TRUE),
        ('Crown',       '👑', 25.00,  TRUE),
        ('Diamond',     '💎', 50.00,  TRUE),
        ('Rocket',      '🚀', 15.00,  TRUE),
        ('Fire',        '🔥',  8.00,  TRUE)
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✅ Gifts seeded');

    // ── Demo users (for local testing only) ─────────────────────────────────
    if (process.env.NODE_ENV !== 'production') {
      await client.query(`
        INSERT INTO users (phone, name, wallet_balance, is_host) VALUES
          ('+919876543210', 'Demo User',  200.00, FALSE),
          ('+919876543211', 'Demo Host',  500.00, TRUE)
        ON CONFLICT (phone) DO UPDATE SET
          wallet_balance = EXCLUDED.wallet_balance
      `);
      console.log('  ✅ Demo users seeded');

      // Make the host user a host
      const { rows } = await client.query(
        `SELECT id FROM users WHERE phone = '+919876543211'`
      );
      if (rows[0]) {
        await client.query(`
          INSERT INTO hosts (user_id, bio, rate_per_minute, is_audio_enabled, is_video_enabled, is_online)
          VALUES ($1, 'Demo host for testing 🎙️', 2.00, TRUE, TRUE, TRUE)
          ON CONFLICT (user_id) DO UPDATE SET is_online = TRUE
        `, [rows[0].id]);
        console.log('  ✅ Demo host profile created');
      }
    }

    console.log('\n✅ Seeding complete!\n');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
});
