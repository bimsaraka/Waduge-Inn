const { reviewUrl, publicConfig } = require('./booking-utils');
const { bookingRoomColumns } = require('./inventory');

function emailConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.NOTIFICATION_FROM && env.NOTIFICATION_TO &&
    reviewUrl('configuration-check', env));
}

function emailPayload(booking, env = process.env) {
  return {
    from: env.NOTIFICATION_FROM,
    to: [env.NOTIFICATION_TO],
    subject: `Waduge Inn booking request ${booking.id}`,
    text: [
      'New booking request — confirmation required.',
      `Reference: ${booking.id}`, `Guest: ${booking.guest_name}`,
      `Email: ${booking.guest_email}`, `Phone: ${booking.guest_phone}`,
      `Room: ${booking.room_number} (${booking.room_type})`,
      `Dates: ${booking.check_in} to ${booking.check_out}`,
      `Guests: ${booking.guest_count}`,
      `Total: ${publicConfig(env).currency} ${booking.total_price}`,
      `Review booking (admin login required): ${reviewUrl(booking.id, env)}`
    ].join('\n')
  };
}

async function sendEmail(payload, id, { env = process.env, fetchImpl = fetch } = {}) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `booking-request/${id}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
  const data = await response.json();
  if (!data.id) throw new Error('Email provider did not acknowledge the message.');
  return data.id;
}

async function processNotifications(pool) {
  if (!emailConfigured()) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT n.*, b.guest_name, b.guest_email, b.guest_phone, b.guest_count,
        b.check_in::text, b.check_out::text, b.total_price, b.hold_expires_at,
        ${bookingRoomColumns}
      FROM booking_notifications n JOIN bookings b ON b.id = n.booking_id
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE n.sent_at IS NULL AND n.attempts < 8 AND n.next_attempt_at <= NOW()
        AND n.created_at > NOW() - INTERVAL '23 hours'
      ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED;
    `);
    if (result.rowCount) {
      const row = result.rows[0];
      const payload = row.payload || emailPayload({ ...row, id: row.booking_id });
      try {
        const providerId = await sendEmail(payload, row.booking_id);
        await client.query(`UPDATE booking_notifications SET sent_at = NOW(),
          provider_id = $2, payload = $3, last_error = NULL WHERE booking_id = $1`,
        [row.booking_id, providerId, JSON.stringify(payload)]);
      } catch (err) {
        await client.query(`UPDATE booking_notifications SET attempts = attempts + 1,
          payload = $2, last_error = $3,
          next_attempt_at = NOW() + INTERVAL '1 minute' * LEAST(30, power(2, attempts))
          WHERE booking_id = $1`, [row.booking_id, JSON.stringify(payload), err.message]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

module.exports = { emailConfigured, emailPayload, sendEmail, processNotifications };
