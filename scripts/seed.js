// scripts/seed.js — Seed initial data (gifts)
// Usage: node scripts/seed.js

require('dotenv').config();
const { pool } = require('../src/config/database');

const seed = async () => {
  const client = await pool.connect();
  console.log('🌱 Seeding database...');

  try {
    await client.query('BEGIN');

    // ── Gifts ────────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO gifts (id, name, emoji, price) VALUES
        (1, 'Rose',    '🌹',   10),
        (2, 'Heart',   '❤️',  20),
        (3, 'Star',    '⭐',   30),
        (4, 'Fire',    '🔥',   50),
        (5, 'Diamond', '💎',  100),
        (6, 'Crown',   '👑',  200),
        (7, 'Rocket',  '🚀',  500),
        (8, 'Trophy',  '🏆',  999)
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('  ✅ gifts seeded');

    await client.query('COMMIT');
    console.log('\n✅ Seeding completed!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
