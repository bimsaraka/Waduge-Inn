const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
});

// Apply the same schema for new and existing installations before accepting bookings.
pool.ready = (async () => {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
    const error = new Error('Set DATABASE_URL in the hosting service Variables before deploying.');
    error.code = 'DATABASE_URL_MISSING';
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(73194602)");
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
})();

module.exports = pool;
