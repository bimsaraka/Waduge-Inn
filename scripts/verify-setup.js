// Applies normal startup migrations and performs read-only HTTP checks.
// Does not create bookings, edit rooms, or start the email worker.
require('dotenv/config');
const assert = require('node:assert/strict');
const app = require('../server');
const pool = require('../src/db');

async function main() {
  let server;
  try {
    await pool.ready;
    console.log('Database startup migrations: passed');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/', '/rooms.html', '/booking.html', '/booking-status.html', '/admin', '/catalog.css', '/rooms.js', '/healthz']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
    }
    console.log('Guest pages and admin page: passed');
    const config = await (await fetch(base + '/api/config')).json();
    const rooms = await (await fetch(base + '/api/rooms')).json();
    assert.equal(rooms.success, true);
    const floors = await (await fetch(base + '/api/floors')).json();
    assert.equal(floors.success, true);
    console.log(`Inventory API: passed (${rooms.data.length} real rooms; ${floors.data.length} floors)`);
    const arrival = new Date(); arrival.setUTCDate(arrival.getUTCDate() + 2);
    const departure = new Date(arrival); departure.setUTCDate(departure.getUTCDate() + 1);
    const query = new URLSearchParams({ checkIn: arrival.toISOString().slice(0, 10), checkOut: departure.toISOString().slice(0, 10) });
    assert.equal((await fetch(base + '/api/availability?' + query)).status, 200);
    assert.equal((await fetch(base + '/api/floors?' + query)).status, 200);
    assert.equal((await fetch(base + '/api/admin/bookings')).status, 401);
    assert.equal((await fetch(base + '/api/booking-status')).status, 404);
    const invalid = await fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
    console.log('Availability and protected endpoints: passed');
    if (process.env.ADMIN_PASSWORD) {
      const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const notifications = await fetch(base + '/api/admin/notifications', { headers: { Cookie: cookie } });
      assert.equal(notifications.status, 200);
      assert.equal((await fetch(base + '/api/admin/bookings', { headers: { Cookie: cookie } })).status, 200);
      const settings = await notifications.json();
      console.log('Admin login and booking list: passed');
      console.log(`Settings: WhatsApp ${settings.whatsappConfigured ? 'ready' : 'pending'}, bank ${settings.bankConfigured ? 'ready' : 'pending'}, email ${settings.emailConfigured ? 'ready' : 'pending'}`);
      await fetch(base + '/api/admin/logout', { method: 'POST', headers: { Cookie: cookie } });
    }
    console.log(`Currency: ${config.currency}. No messages sent or booking data created.`);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
  }
}
main().catch(error => { console.error('Setup verification failed:', error.code || error.message); process.exitCode = 1; });
