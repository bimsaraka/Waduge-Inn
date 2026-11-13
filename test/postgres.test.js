const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const { registerAuth } = require('../src/auth');
const { registerBookings } = require('../src/booking-api');

test('PostgreSQL: concurrent requests, duplicate retries, persistent pending reservations and staff confirmation', {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `booking_test_${crypto.randomBytes(8).toString('hex')}`;
  let pool;
  let server;
  try {
    const existing = await admin.query("SELECT to_regclass('public.rooms') AS rooms, to_regclass('public.bookings') AS bookings");
    assert.equal(existing.rows[0].rooms, null, 'Use a separate empty test database, never the production database.');
    assert.equal(existing.rows[0].bookings, null, 'Use a separate empty test database, never the production database.');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public` });
    const ddl = fs.readFileSync('schema.sql', 'utf8');
    await pool.query(ddl);
    await pool.query(ddl); // Startup migration must also work on an existing schema.
    const room = (await pool.query(`INSERT INTO rooms
      (room_number, room_type, price_per_night, max_occupancy) VALUES ('1','Double',50,2) RETURNING *`)).rows[0];
    process.env.ADMIN_PASSWORD = 'integration-test-password';
    const app = express();
    app.use(express.json());
    registerAuth(app);
    registerBookings(app, pool);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/admin/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const body = { roomId: room.id, guestName: 'Test Guest', guestEmail: 'test@example.com',
      guestType: 'local', guestIdentity: '199012345678', guestPhone: '+94771234567', guestCount: 2, checkIn: '2099-06-01', checkOut: '2099-06-03' };
    const request = async value => {
      const response = await fetch(base + '/api/bookings', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      return { status: response.status, ...await response.json() };
    };
    const firstBody = { ...body, requestKey: crypto.randomUUID() };
    const secondBody = { ...body, requestKey: crypto.randomUUID() };
    const results = await Promise.all([request(firstBody), request(secondBody)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const winnerIndex = results.findIndex(r => r.status === 201);
    const winner = results[winnerIndex].booking;
    assert.equal(winner.total_price, '100.00');
    const retry = await request(winnerIndex === 0 ? firstBody : secondBody);
    assert.equal(retry.booking.id, winner.id);
    assert.equal((await pool.query('SELECT * FROM booking_notifications')).rowCount, 1);
    await assert.rejects(pool.query(`INSERT INTO bookings
      (room_id,guest_name,guest_email,guest_phone,check_in,check_out,total_price,status)
      VALUES ($1,'Other','other@example.com','12345678','2099-06-02','2099-06-04',100,'confirmed')`,
    [room.id]), { code: '23P01' });
    const adjacent = await request({ ...body, requestKey: crypto.randomUUID(), checkIn: '2099-06-03', checkOut: '2099-06-04' });
    assert.equal(adjacent.status, 201);
    assert.equal((await request({ ...body, requestKey: crypto.randomUUID(), guestCount: 3, checkIn: '2099-07-01', checkOut: '2099-07-02' })).status, 400);
    await pool.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [winner.id]);
    const available = await fetch(base + '/api/availability?checkIn=2099-06-01&checkOut=2099-06-03');
    assert.equal((await available.json()).data.length, 0);
    const patch = (id, status) => fetch(base + `/api/admin/bookings/${id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ status }) });
    const payment = (id, paidAmount, expectedPaidAmount = '0.00') => fetch(base + `/api/admin/bookings/${id}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ paidAmount, expectedPaidAmount, reference: 'Verified bank credit' })
    });
    assert.equal((await patch(winner.id, 'confirmed')).status, 409);
    assert.equal((await payment(winner.id, '101.00')).status, 409);
    assert.equal((await payment(winner.id, '30.00')).status, 200);
    assert.equal((await payment(winner.id, '50.00')).status, 409); // Stale previous total.
    assert.equal((await pool.query('SELECT * FROM booking_payment_records')).rowCount, 1);
    assert.equal((await patch(winner.id, 'confirmed')).status, 200);
    assert.equal((await payment(adjacent.booking.id, '50.00')).status, 200);
    const confirmation = await patch(adjacent.booking.id, 'confirmed');
    assert.equal(confirmation.status, 200);
    const confirmed = await confirmation.json();
    assert.equal(new URL(confirmed.confirmationWhatsappUrl).pathname, '/94771234567');
    assert.match(new URL(confirmed.confirmationWhatsappUrl).searchParams.get('text'), /booking at Waduge Inn is confirmed/);
    await pool.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [adjacent.booking.id]);
    const blocked = await fetch(base + '/api/availability?checkIn=2099-06-03&checkOut=2099-06-04');
    assert.equal((await blocked.json()).data.length, 0); // Confirmed bookings never expire.
    assert.equal((await patch(adjacent.booking.id, 'cancelled')).status, 200);
    assert.equal((await patch(adjacent.booking.id, 'confirmed')).status, 409);

    const extraRoom = (await pool.query(`INSERT INTO rooms
      (room_number, room_type, floor_number, price_per_night, max_occupancy)
      VALUES ('2','Twin',1,25,2) RETURNING *`)).rows[0];
    const upstairs = (await pool.query(`INSERT INTO rooms
      (room_number, room_type, floor_number, price_per_night, max_occupancy)
      VALUES ('201','Family',2,90,4) RETURNING *`)).rows[0];
    const floorBody = { ...body, roomId: undefined, floorNumber: 1, guestCount: 4,
      checkIn: '2099-08-01', checkOut: '2099-08-03', requestKey: crypto.randomUUID() };
    const wholeFloor = await request(floorBody);
    assert.equal(wholeFloor.status, 201);
    assert.equal(wholeFloor.booking.room_id, null);
    assert.equal(wholeFloor.booking.floor_number, 1);
    assert.equal(wholeFloor.booking.total_price, '150.00');
    assert.equal((await request(floorBody)).booking.id, wholeFloor.booking.id);
    assert.equal((await request({ ...floorBody, floorNumber: 2 })).status, 409); // Reused key.
    const afterFloor = await fetch(base + '/api/availability?checkIn=2099-08-01&checkOut=2099-08-03');
    assert.deepEqual((await afterFloor.json()).data.map(r => r.id), [upstairs.id]);
    for (const roomId of [room.id, extraRoom.id]) {
      assert.equal((await request({ ...body, roomId, checkIn: '2099-08-01', checkOut: '2099-08-03', requestKey: crypto.randomUUID() })).status, 409);
      await assert.rejects(pool.query(`INSERT INTO bookings
        (room_id, guest_name, guest_email, guest_phone, check_in, check_out, total_price)
        VALUES ($1,'Direct','direct@example.com','0771234567','2099-08-01','2099-08-03',100)`, [roomId]), { code: '23P01' });
    }
    await assert.rejects(pool.query('UPDATE rooms SET floor_number = 2 WHERE id = $1', [extraRoom.id]), { code: '23514' });
    const floorStatus = await fetch(base + '/api/booking-status', { headers: { 'X-Booking-Token': wholeFloor.booking.status_token } });
    assert.equal((await floorStatus.json()).booking.room_type, 'Entire floor');
    const adminBookings = await fetch(base + '/api/admin/bookings', { headers: { Cookie: cookie } });
    assert.ok((await adminBookings.json()).data.some(b => b.id === wholeFloor.booking.id && b.room_type === 'Entire floor'));
    const floorAvailability = await fetch(base + '/api/floors?checkIn=2099-08-01&checkOut=2099-08-03');
    const floorData = (await floorAvailability.json()).data;
    assert.equal(floorData.find(f => f.floor_number === 1).available, false);
    assert.equal(floorData.find(f => f.floor_number === 2).available, true);
    assert.equal((await patch(wholeFloor.booking.id, 'confirmed')).status, 409);
    assert.equal((await payment(wholeFloor.booking.id, '45.00')).status, 200);
    assert.equal((await patch(wholeFloor.booking.id, 'confirmed')).status, 200);
    assert.equal((await patch(wholeFloor.booking.id, 'cancelled')).status, 200);
    const roomOnFloor = await request({ ...body, checkIn: '2099-08-01', checkOut: '2099-08-03', requestKey: crypto.randomUUID() });
    assert.equal(roomOnFloor.status, 201);
    assert.equal((await request({ ...body, roomId: extraRoom.id, checkIn: '2099-08-01', checkOut: '2099-08-03', requestKey: crypto.randomUUID() })).status, 201);
    assert.equal((await request({ ...floorBody, requestKey: crypto.randomUUID() })).status, 409);
    await assert.rejects(pool.query(`INSERT INTO bookings
      (floor_number, guest_name, guest_email, guest_phone, check_in, check_out, total_price)
      VALUES (1,'Direct','direct@example.com','0771234567','2099-08-01','2099-08-03',150)`), { code: '23P01' });
    const race = await Promise.all([
      request({ ...floorBody, floorNumber: 2, checkIn: '2099-09-01', checkOut: '2099-09-03', requestKey: crypto.randomUUID() }),
      request({ ...body, roomId: upstairs.id, checkIn: '2099-09-01', checkOut: '2099-09-03', requestKey: crypto.randomUUID() })
    ]);
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
    assert.equal((await request({ ...floorBody, checkIn: '2099-08-03', checkOut: '2099-08-04', requestKey: crypto.randomUUID() })).status, 201);
    assert.equal((await request({ ...floorBody, guestCount: 5, checkIn: '2099-10-01', checkOut: '2099-10-03', requestKey: crypto.randomUUID() })).status, 400);
    await pool.query(ddl); // Re-running the migration preserves floor bookings too.
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
