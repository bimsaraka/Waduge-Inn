require('dotenv/config');
const express = require('express');
const path = require('path');
const { registerAuth, requireAdmin, sameOrigin } = require('./src/auth');
const pool = require('./src/db');
const { registerBookings, startBookingWorkers } = require('./src/booking-api');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
// Set only when the application is behind a single trusted HTTPS reverse proxy.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Middleware

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
registerAuth(app);

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// API ENDPOINTS (CONNECTED TO SUPABASE)
// ==========================================

require('./src/room-api').registerRooms(app, pool);

app.patch('/api/rooms/:id/floor', sameOrigin, requireAdmin, async (req, res) => {
  if (!require('./src/booking-utils').UUID.test(req.params.id) || ![1, 2].includes(req.body.floorNumber)) {
    return res.status(400).json({ error: 'Choose a valid room and floor.' });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Same floor locks as booking creation, in a fixed order.
    await client.query('SELECT pg_advisory_xact_lock(72100, 1)');
    await client.query('SELECT pg_advisory_xact_lock(72100, 2)');
    const result = await client.query('UPDATE rooms SET floor_number = $2, updated_at = NOW() WHERE id = $1 RETURNING id, floor_number', [req.params.id, req.body.floorNumber]);
    await client.query('COMMIT');
    if (!result.rowCount) return res.status(404).json({ error: 'Room not found.' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(err.code === '23514' ? 409 : 503).json({ error: err.code === '23514' ? 'This room has active room or floor reservations. Resolve them before changing its floor.' : 'Could not change floor. Please retry.' });
  } finally { if (client) client.release(); }
});

registerBookings(app, pool);

app.get('/healthz', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

// Fallback HTML page routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start Server with Port Fallback
function startServer(port) {
  const numericPort = parseInt(port, 10) || 3000;
  const server = app.listen(numericPort, () => {
    console.log(`\n=================================================`);
    console.log(` Waduge Inn Server running successfully!`);
    console.log(` Public Website:  http://localhost:${numericPort}`);
    console.log(` Admin Dashboard: http://localhost:${numericPort}/admin.html`);
    console.log(` Database:        Supabase PostgreSQL Pool`);
    console.log(` Mock Data:       STRICTLY 0 (Clean schema)`);
    console.log(`=================================================\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${numericPort} is currently in use. Trying port ${numericPort + 1}...`);
      startServer(numericPort + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}


if (require.main === module) {
  pool.ready.then(() => { startBookingWorkers(pool); startServer(PORT); }).catch(err => {
    // AggregateError can have an empty message. Log codes, including nested
    // connection failures, without exposing connection strings or credentials.
    const codes = new Set();
    function collectCodes(error) {
      if (!error) return;
      if (error.code) codes.add(String(error.code));
      if (Array.isArray(error.errors)) error.errors.forEach(collectCodes);
      if (error.cause) collectCodes(error.cause);
    }
    collectCodes(err);
    console.error('Database initialization failed. Server was not started:',
      codes.size ? [...codes].join(', ') : (err.name || 'UnknownError'));
    console.error('Check DATABASE_URL in Railway Variables. For Supabase, use the Session pooler URI on port 5432 with the database password.');
    process.exitCode = 1;
    pool.end();
  });
}
module.exports = app;
