const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { floorSummary } = require('../src/inventory');
const { validateGuest } = require('../src/booking-utils');
const { registerBookings } = require('../src/booking-api');

const rooms = [
  { id: 'one', floor_number: 1, price_per_night: '10.01', max_occupancy: 2, available: false },
  { id: 'two', floor_number: 1, price_per_night: '20.02', max_occupancy: 3, available: false },
  { id: 'three', floor_number: 2, price_per_night: '50.00', max_occupancy: 4, available: true }
];

test('floor summaries sum only that floor, preserve cents and reject empty floors', () => {
  const floor = floorSummary(rooms, 1);
  assert.equal(floor.id, 'floor-1');
  assert.equal(floor.room_count, 2);
  assert.equal(floor.max_occupancy, 5);
  assert.equal(floor.price_per_night, '30.03');
  assert.equal(floorSummary(rooms, 2).price_per_night, '50.00');
  assert.equal(floorSummary([], 1), null);
});

test('guest booking must select exactly one room or valid floor', () => {
  const body = { guestName: 'Guest', guestEmail: 'guest@example.com', guestType: 'local', guestIdentity: '199012345678', guestPhone: '0771234567', guestCount: 3,
    requestKey: '11111111-1111-4111-8111-111111111111', floorNumber: 1 };
  assert.doesNotThrow(() => validateGuest(body));
  for (const change of [{ floorNumber: 3 }, { floorNumber: '1' }, { floorNumber: null },
    { roomId: '11111111-1111-4111-8111-111111111111' }]) assert.throws(() => validateGuest({ ...body, ...change }));
});

test('incomplete floor rates and capacity stay unknown instead of becoming partial totals', () => {
  const floor = floorSummary([{ ...rooms[0], price_per_night: null, max_occupancy: null }, rooms[1]], 1);
  assert.equal(floor.room_count, 2);
  assert.equal(floor.price_per_night, null);
  assert.equal(floor.max_occupancy, null);
  assert.equal(floor.has_kitchen, true);
});

test('a direct booking request cannot book an unpriced room or floor for free', async t => {
  const client = {
    release() {},
    async query(sql) {
      if (sql.includes('INSERT INTO bookings')) assert.fail('Draft rooms cannot create bookings');
      if (sql.includes('FROM bookings WHERE request_key')) return { rows: [] };
      if (sql.includes('SELECT floor_number FROM rooms')) return { rows: [{ floor_number: 1 }] };
      if (sql.includes('SELECT * FROM rooms')) return { rowCount: 1, rows: [{ ...rooms[0], price_per_night: null }] };
      return { rows: [], rowCount: 0 };
    }
  };
  const app = express(); app.use(express.json()); registerBookings(app, { connect: async () => client });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = { guestName: 'Guest', guestEmail: 'guest@example.com', guestPhone: '0771234567', guestType: 'local', guestIdentity: '199012345678', guestCount: 1,
    requestKey: '11111111-1111-4111-8111-111111111111', checkIn: '2099-08-01', checkOut: '2099-08-03' };
  for (const accommodation of [{ roomId: '22222222-2222-4222-8222-222222222222' }, { floorNumber: 1 }]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...accommodation }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /still being prepared/);
  }
});

test('floor availability uses all active reservations on the floor and validates dates', async t => {
  let queries = 0;
  const app = express();
  registerBookings(app, { query: async (sql, params) => {
    queries++;
    assert.match(sql, /b.floor_number = r.floor_number/);
    assert.match(sql, /b.status IN \('pending', 'confirmed'\)/);
    assert.deepEqual(params, ['2099-08-01', '2099-08-03']);
    return { rows: rooms };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/floors?checkIn=bad')).status, 400);
  assert.equal(queries, 0);
  const response = await fetch(base + '/api/floors?checkIn=2099-08-01&checkOut=2099-08-03');
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data[0].available, false);
  assert.equal(data[1].available, true);
  assert.equal(data[0].max_occupancy, 5);
});

test('floor requests use server prices, one booking reference and the sum of room capacity', async t => {
  let inserts = 0;
  let saved;
  const members = rooms.filter(room => room.floor_number === 1);
  const client = {
    release() {},
    async query(sql, values) {
      if (sql.includes('FROM bookings WHERE request_key')) return { rows: saved ? [saved] : [] };
      if (sql.includes('SELECT * FROM rooms')) return { rowCount: members.length, rows: members };
      if (sql.includes('SELECT id FROM bookings')) {
        assert.equal(values[0], 1);
        assert.equal(values[3], null);
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO bookings')) {
        inserts++;
        assert.equal(values[0], null);
        assert.equal(values[7], '60.06'); // Two nights, using server room rates.
        assert.equal(values[11], 1);
        saved = { id: '22222222-2222-4222-8222-222222222222', room_id: null, floor_number: 1,
          guest_name: values[1], guest_email: values[2], guest_phone: values[3], guest_count: values[4],
          guest_type: values[12], guest_identity: values[13],
          check_in: values[5], check_out: values[6], total_price: values[7], request_key: values[8],
          payment_choice: values[9], advance_percent: values[10], paid_amount: '0.00', status: 'pending', status_token: 'a'.repeat(64) };
        return { rows: [saved] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  const app = express();
  app.use(express.json());
  registerBookings(app, { connect: async () => client });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/bookings`;
  const body = { guestName: 'Guest', guestEmail: 'guest@example.com', guestType: 'local', guestIdentity: '199012345678', guestPhone: '0771234567', guestCount: 5,
    requestKey: '11111111-1111-4111-8111-111111111111', floorNumber: 1,
    checkIn: '2099-08-01', checkOut: '2099-08-03', totalPrice: '0.01' };
  const send = value => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await send({ ...body, guestCount: 6 })).status, 400);
  assert.equal(inserts, 0);
  const response = await send(body);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.booking.total_price, '60.06');
  assert.equal(result.booking.room_id, null);
  assert.equal(result.payment.minimumAdvance, '18.02');
  assert.equal((await (await send(body)).json()).booking.id, result.booking.id);
  assert.equal(inserts, 1);
  assert.equal((await send({ ...body, floorNumber: 2 })).status, 409);
});
