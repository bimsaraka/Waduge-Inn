const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerBookings } = require('../src/booking-api');

test('private booking lookup requires the secret token and selects no guest contact data', async t => {
  const token = 'a'.repeat(64);
  let calls = 0;
  const pool = { query: async (sql, values) => {
    calls++;
    assert.doesNotMatch(sql, /guest_email|guest_phone|guest_name|SELECT\s+\*/i);
    assert.doesNotMatch(sql, /hold_expires_at <=/);
    assert.match(sql, /WHERE b.status_token = \$1/);
    if (values[0] !== token) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ id: 'reference', status: 'confirmed', total_price: '100.00', paid_amount: '30.00' }] };
  } };
  const app = express();
  registerBookings(app, pool);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/booking-status`;
  for (const headers of [{}, { 'X-Booking-Token': 'reference' }]) {
    assert.equal((await fetch(url, { headers })).status, 404);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(url, { headers: { 'X-Booking-Token': 'b'.repeat(64) } })).status, 404);
  const response = await fetch(url, { headers: { 'X-Booking-Token': token } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).booking.status, 'confirmed');
});
