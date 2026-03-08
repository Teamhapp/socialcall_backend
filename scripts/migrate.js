#!/usr/bin/env node
/**
 * Database migration runner
 * Usage:  node scripts/migrate.js
 *         npm run migrate
 *
 * Runs all SQL files in /migrations in alphabetical order.
 * Skips files already recorded in the _migrations table.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ─── Connect ─────────────────────────────────────────────────────────────────
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

// ─── Run ─────────────────────────────────────────────────────────────────────
async function migrate() {
  const client = await pool.connect();

  try {
    console.log('🔄 Running database migrations...\n');

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT filename FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    // Get all SQL files sorted
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  ✅ ${file} — already applied`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  🆕 ${file} — applied`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ ${file} — FAILED: ${err.message}`);
        throw err;
      }
    }

    console.log(`\n✅ Migration complete. ${ran} new file(s) applied.\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
