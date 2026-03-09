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
      INSERT INTO gifts (name, emoji, price) VALUES
        ('Rose',        '🌹',  10),
        ('Heart',       '❤️',  20),
        ('Star',        '⭐',  30),
        ('Fire',        '🔥',  50),
        ('Diamond',     '💎', 100),
        ('Crown',       '👑', 200),
        ('Rocket',      '🚀', 500),
        ('Trophy',      '🏆', 999)
      ON CONFLICT DO NOTHING;
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
