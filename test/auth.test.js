const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAuth, requireAdmin } = require('../src/auth');

test('admin authentication protects data, rejects cross-origin writes, and revokes logout', async () => {
  process.env.ADMIN_PASSWORD = 'test-password-for-auth';
  const app = express();
  app.use(express.json());
  registerAuth(app);
  app.get('/api/admin/bookings', requireAdmin, (req, res) => res.json([]));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/admin/bookings')).status, 401);
    const login = password => fetch(base + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    });
    assert.equal((await login('wrong')).status, 401);
    const response = await login(process.env.ADMIN_PASSWORD);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.equal((await fetch(base + '/api/admin/bookings', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/admin/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/admin/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/admin/bookings', { headers: { Cookie: cookie } })).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login(process.env.ADMIN_PASSWORD)).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inline browser scripts parse successfully', () => {
  const fs = require('fs');
  for (const file of ['public/index.html', 'public/admin.html']) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
    assert.doesNotMatch(html, /ADMIN_PASSCODE|waduge_admin_auth|Reservation Confirmed!/);
  }
});
