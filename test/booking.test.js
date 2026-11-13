const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const { dateRange, publicConfig, whatsappUrl, validateGuest, reviewUrl,
  whatsappPhone, confirmationWhatsappUrl } = require('../src/booking-utils');
const { sendEmail, emailConfigured, emailPayload } = require('../src/notifications');
const { registerBookings } = require('../src/booking-api');

const roomId = '11111111-1111-4111-8111-111111111111';
const bookingId = '22222222-2222-4222-8222-222222222222';
const body = {
  roomId, requestKey: bookingId, guestName: 'Guest', guestEmail: 'guest@example.com', guestType: 'local', guestIdentity: '199012345678',
  guestPhone: '+94 77 123 4567', guestCount: 2, checkIn: '2099-06-01', checkOut: '2099-06-03'
};

test('dates reject invalid days, past stays and reversed ranges', () => {
  assert.equal(dateRange('2099-06-01', '2099-06-03', '2099-05-01'), 2);
  for (const dates of [['2099-02-29', '2099-03-02'], ['2099-06-03', '2099-06-01'],
    ['2099-06-01', '2099-06-01'], ['2020-01-01', '2020-01-02'], ['2099-01-01', '2101-01-01']]) {
    assert.throws(() => dateRange(...dates, '2099-05-01'));
  }
});

test('guest fields and room/reference ids are validated before database access', () => {
  assert.doesNotThrow(() => validateGuest(body));
  for (const change of [{ guestName: 2 }, { guestCount: 1.5 }, { guestCount: 0 },
    { guestEmail: 'bad-email' }, { roomId: 'bad-id' }, { guestPhone: 'invalid' }]) {
    assert.throws(() => validateGuest({ ...body, ...change }));
  }
});

test('local guests require a NIC and foreign guests require a passport', () => {
  for (const guestIdentity of ['199012345678', '901234567V', '901234567x']) {
    assert.doesNotThrow(() => validateGuest({ ...body, guestIdentity }));
  }
  assert.doesNotThrow(() => validateGuest({ ...body, guestType: 'foreign', guestIdentity: ' AB1234567 ' }));
  for (const change of [{ guestType: undefined }, { guestType: 'other' }, { guestIdentity: '' },
    { guestIdentity: 'AB1234567' }, { guestIdentity: 199012345678 },
    { guestType: 'foreign', guestIdentity: '' }, { guestType: 'foreign', guestIdentity: '  ' },
    { guestType: 'foreign', guestIdentity: '<script>' }, { guestType: 'foreign', guestIdentity: 'A'.repeat(31) }]) {
    assert.throws(() => validateGuest({ ...body, ...change }));
  }
});

test('WhatsApp can be configured later; messages encode details and a protected review link', () => {
  const booking = { id: bookingId, guest_name: 'Guest & Friend', guest_count: 2,
    check_in: body.checkIn, check_out: body.checkOut, total_price: '100.00', hold_expires_at: '2099-05-01T12:30:00Z' };
  const room = { room_number: '2', room_type: 'Double' };
  assert.equal(whatsappUrl(booking, room, {}), null);
  assert.equal(publicConfig({ WHATSAPP_NUMBER: 'not a number' }).whatsappNumber, null);
  const env = { WHATSAPP_NUMBER: '+94 77 123 4567', PUBLIC_BASE_URL: 'https://inn.example', CURRENCY: 'LKR' };
  const link = new URL(whatsappUrl(booking, room, env));
  assert.equal(link.origin + link.pathname, 'https://wa.me/94771234567');
  assert.match(link.searchParams.get('text'), /Guest & Friend/);
  assert.match(link.searchParams.get('text'), /LKR 100.00/);
  assert.match(link.searchParams.get('text'), /admin login required/);
  assert.match(link.searchParams.get('text'), new RegExp(`/admin\\?booking=${bookingId}`));
  assert.equal(reviewUrl(bookingId, { PUBLIC_BASE_URL: 'javascript:alert(1)' }), null);
});

test('email sender uses provider idempotency and reports failures instead of claiming delivery', async () => {
  assert.equal(emailConfigured({}), false);
  const env = { RESEND_API_KEY: 'test-key', NOTIFICATION_FROM: 'inn@example.com',
    NOTIFICATION_TO: 'staff@example.com', PUBLIC_BASE_URL: 'https://inn.example' };
  assert.equal(emailConfigured(env), true);
  const payload = emailPayload({ id: bookingId, hold_expires_at: '2099-01-01T00:00:00Z' }, env);
  assert.match(payload.text, /admin\?booking=/);
  let calls = 0;
  const options = { env, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers['Idempotency-Key'], `booking-request/${bookingId}`);
    assert.equal(JSON.parse(init.body).to[0], env.NOTIFICATION_TO);
    return { ok: true, json: async () => ({ id: 'provider-id' }) };
  } };
  assert.equal(await sendEmail(payload, bookingId, options), 'provider-id');
  assert.equal(calls, 1);
  await assert.rejects(sendEmail(payload, bookingId, { env, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('guest confirmation only exists for confirmed bookings and formats WhatsApp numbers', () => {
  assert.equal(whatsappPhone('077 123 4567'), '94771234567');
  assert.equal(whatsappPhone('+44 7700 900123'), '447700900123');
  assert.equal(whatsappPhone('0094 77 123 4567'), '94771234567');
  assert.equal(whatsappPhone('invalid phone'), null);
  const booking = { id: bookingId, guest_name: 'Guest & Friend', guest_phone: '0771234567',
    room_number: '2', room_type: 'Double', check_in: body.checkIn, check_out: body.checkOut,
    guest_count: 2, total_price: '100.00', status: 'confirmed' };
  const link = new URL(confirmationWhatsappUrl(booking, { CURRENCY: 'LKR' }));
  assert.equal(link.pathname, '/94771234567');
  const text = link.searchParams.get('text');
  assert.match(text, /Guest & Friend/);
  assert.match(text, /booking at Waduge Inn is confirmed/);
  assert.match(text, /LKR 100.00/);
  assert.match(text, /2099-06-01/);
  for (const status of ['pending', 'expired', 'cancelled']) {
    assert.equal(confirmationWhatsappUrl({ ...booking, status }), null);
  }
  assert.equal(confirmationWhatsappUrl({ ...booking, guest_phone: 'bad' }), null);
});

test('booking APIs reject bad input, protect staff data, and handle database downtime', async () => {
  const app = express();
  app.use(express.json());
  const pool = { query: async () => { throw new Error('Test database unavailable'); } };
  registerBookings(app, pool);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/availability?checkIn=invalid')).status, 400);
    assert.equal((await fetch(base + '/api/admin/bookings')).status, 401);
    assert.equal((await fetch(base + '/api/admin/notifications')).status, 401);
    const send = value => fetch(base + '/api/bookings', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await send({})).status, 400);
    assert.equal((await send(body)).status, 503);
    assert.equal((await fetch(base + '/api/availability?checkIn=2099-06-01&checkOut=2099-06-03')).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('external booking script parses', () => {
  assert.doesNotThrow(() => new Function(fs.readFileSync('public/booking.js', 'utf8')));
});
