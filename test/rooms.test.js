const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAuth } = require('../src/auth');
const { registerRooms, roomDetails } = require('../src/room-api');

const room = { roomNumber: '101', roomType: 'Double', floorNumber: 1, pricePerNight: '125.50', maxOccupancy: 2,
  description: 'Lake-facing room', imageUrl: '/assets/room-101.jpg' };

test('room input rejects partial numbers, unsafe image URLs and invalid capacity', () => {
  assert.deepEqual(roomDetails(room), ['101', 'Double', '125.50', 2, 'Lake-facing room', 1, '/assets/room-101.jpg']);
  assert.equal(roomDetails({ ...room, imageUrl: 'https://example.com/room.jpg' })[6], 'https://example.com/room.jpg');
  const draft = roomDetails({ ...room, pricePerNight: '', maxOccupancy: null });
  assert.equal(draft[2], null);
  assert.equal(draft[3], null);
  for (const change of [{ pricePerNight: '12oops' }, { pricePerNight: '1.234' }, { maxOccupancy: 1.5 },
    { maxOccupancy: 0 }, { floorNumber: 3 }, { roomNumber: 101 }, { roomType: ' ' },
    { imageUrl: 'javascript:alert(1)' }, { imageUrl: '//example.com/image.jpg' },
    { imageUrl: '/assets/../.env' }, { imageUrl: 'https://user:password@example.com/image.jpg' }]) {
    assert.throws(() => roomDetails({ ...room, ...change }));
  }
});

test('room create/edit require admin and validation; edit persists photo and price', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  let writes = 0;
  const query = async (sql, values) => {
    if (sql.includes('INSERT INTO rooms') || sql.includes('UPDATE rooms SET')) {
      writes++;
      assert.deepEqual(values.slice(0, 7), roomDetails(room));
      if (sql.includes('UPDATE')) assert.equal(values[7], id);
      return { rowCount: 1, rows: [{ id, room_number: values[0], price_per_night: values[2], image_url: values[6] }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const app = express(); app.use(express.json());
  process.env.ADMIN_PASSWORD = 'room-management-test';
  registerAuth(app);
  registerRooms(app, { query, connect: async () => ({ query, release() {} }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method, body, cookie, origin) => fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await send('/api/rooms', 'POST', room)).status, 401);
  assert.equal((await send('/api/rooms/' + id, 'PATCH', room)).status, 401);
  const login = await send('/api/admin/login', 'POST', { password: process.env.ADMIN_PASSWORD });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await send('/api/rooms', 'POST', { ...room, maxOccupancy: 1.2 }, cookie)).status, 400);
  assert.equal((await send('/api/rooms', 'POST', room, cookie, 'https://other.example')).status, 403);
  assert.equal(writes, 0);
  assert.equal((await send('/api/rooms', 'POST', room, cookie)).status, 201);
  const edited = await send('/api/rooms/' + id, 'PATCH', room, cookie);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).data.image_url, room.imageUrl);
  assert.equal(writes, 2);
});
