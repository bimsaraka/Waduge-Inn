const { test } = require('node:test');
const assert = require('node:assert/strict');
const { advancePercent, cents, paymentSummary, bankDetailsUrl } = require('../src/payments');
const express = require('express');
const { registerAuth } = require('../src/auth');
const { registerBookings } = require('../src/booking-api');

test('bank transfer amounts round advance upwards to a cent and track verified balance', () => {
  const b = { total_price: '100.01', paid_amount: '0.00', advance_percent: 30 };
  assert.equal(paymentSummary(b).minimumAdvance, '30.01');
  assert.equal(paymentSummary(b).amountDue, '30.01');
  assert.equal(paymentSummary({ ...b, payment_choice: 'full' }).amountDue, '100.01');
  const paid = paymentSummary({ ...b, paid_amount: '30.01' });
  assert.equal(paid.status, 'advance_paid');
  assert.equal(paid.balance, '70.00');
  assert.equal(paid.amountDue, '0.00');
  assert.equal(paymentSummary({ ...b, paid_amount: '100.01' }).status, 'paid');
  assert.equal(paymentSummary({ ...b, paid_amount: '1.00' }).status, 'partially_paid');
  for (const value of [-1, '1.001', '', 'NaN', '1e2', null, '100000000']) assert.throws(() => cents(value));
  assert.equal(advancePercent({ ADVANCE_PERCENT: '40' }), 40);
  assert.equal(advancePercent({ ADVANCE_PERCENT: '101' }), 30);
});

test('bank instructions need configured details and an active booking with a valid guest number', () => {
  const b = { id: 'reference', guest_name: 'Guest', guest_phone: '0771234567',
    status: 'pending', total_price: '100.00', paid_amount: '0.00', advance_percent: 30 };
  const env = { BANK_NAME: 'Test bank', BANK_ACCOUNT_NAME: 'Inn', BANK_ACCOUNT_NUMBER: '123456', CURRENCY: 'LKR' };
  assert.equal(bankDetailsUrl(b, {}), null);
  assert.equal(bankDetailsUrl({ ...b, status: 'cancelled' }, env), null);
  assert.equal(bankDetailsUrl({ ...b, guest_phone: 'bad' }, env), null);
  const url = new URL(bankDetailsUrl(b, env));
  assert.equal(url.pathname, '/94771234567');
  assert.match(url.searchParams.get('text'), /Account number: 123456/);
  assert.match(url.searchParams.get('text'), /Minimum advance \(30%\): LKR 30.00/);
  assert.match(url.searchParams.get('text'), /verify the bank credit/);
});

test('recording payments requires admin access, validates amounts and rejects stale updates', async t => {
  const oldPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'payment-test-password';
  t.after(() => { if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = oldPassword; });
  let queries = 0;
  const pool = { query: async (sql, values) => {
    queries++;
    assert.match(sql, /paid_amount = \$3/);
    assert.match(sql, /INSERT INTO booking_payment_records/);
    assert.match(sql, /total_price >= \$2/);
    assert.equal(values[3], 'bank ref');
    return values[2] === '0.00' ? { rowCount: 1, rows: [{ total_price: '100.00', paid_amount: values[1], advance_percent: 30 }] } : { rowCount: 0, rows: [] };
  } };
  const app = express();
  app.use(express.json());
  registerAuth(app);
  registerBookings(app, pool);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + '/api/admin/bookings/11111111-1111-4111-8111-111111111111/payment';
  assert.equal((await fetch(url, { method: 'PATCH' })).status, 401);
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const send = (body, extra = {}) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  const body = { paidAmount: '30.00', expectedPaidAmount: '0.00', reference: 'bank ref' };
  assert.equal((await send(body, { Origin: 'https://other.example' })).status, 403);
  for (const change of [{ paidAmount: '-1' }, { paidAmount: '3.001' }, { reference: '' }, { expectedPaidAmount: null }]) {
    assert.equal((await send({ ...body, ...change })).status, 400);
  }
  assert.equal(queries, 0);
  const response = await send(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).payment.balance, '70.00');
  assert.equal((await send({ ...body, expectedPaidAmount: '10.00' })).status, 409);
});
