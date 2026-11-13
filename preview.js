const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PREVIEW_PORT) || 3001;
app.use(express.json());

app.get('/api/config', (req, res) => res.json({
  preview: true, whatsappNumber: null, holdMinutes: null, advancePercent: 30, currency: 'USD',
  address: 'Above Gregory Lake, Nuwara Eliya, Sri Lanka.'
}));
app.get('/api/availability', (req, res) => res.json({ success: true, data: [] }));
app.get('/api/floors', (req, res) => res.json({ success: true, data: [] }));
app.get('/api/admin/notifications', (req, res) => res.json({
  emailConfigured: false, whatsappConfigured: false, bankConfigured: false, unsent: 0, failed: 0
}));

// Preview only: no database connection, guest data, or saved changes.
app.get('/api/rooms', (req, res) => res.json({ success: true, data: [] }));
app.get('/api/admin/session', (req, res) => res.json({ authenticated: true }));
app.get('/api/admin/bookings', (req, res) => res.json({ success: true, data: [] }));
app.use('/api', (req, res) => res.status(403).json({
  error: 'Interface preview only. Saving rooms and bookings requires the database server.'
}));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.listen(port, '127.0.0.1', () => {
  console.log(`Interface preview: http://localhost:${port}`);
  console.log(`Admin preview: http://localhost:${port}/admin`);
  console.log('Preview only: no database, no saved bookings or room changes.');
});
