const { requireAdmin, sameOrigin } = require('./auth');
const { UUID, dateRange, publicConfig, whatsappUrl, validateGuest, confirmationWhatsappUrl } = require('./booking-utils');
const { emailConfigured } = require('./notifications');
const { advancePercent, cents, paymentSummary, bankDetailsUrl } = require('./payments');
const { floorSummary, bookingRoomColumns } = require('./inventory');

function registerBookings(app, pool) {
  app.get('/api/config', (req, res) => res.json({ ...publicConfig(), advancePercent: advancePercent() }));

  app.get('/api/booking-status', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const token = req.get('X-Booking-Token');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(404).json({ error: 'Booking link is invalid or unavailable.' });
    }
    try {
      const result = await pool.query(`SELECT b.id,
        b.status, b.room_id, b.floor_number, b.paid_amount, b.advance_percent, b.payment_choice,
        b.check_in::text, b.check_out::text, b.guest_count, b.total_price, b.hold_expires_at,
        ${bookingRoomColumns} FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
        WHERE b.status_token = $1`, [token]);
      if (!result.rowCount) return res.status(404).json({ error: 'Booking link is invalid or unavailable.' });
      res.json({ success: true, booking: result.rows[0], payment: paymentSummary(result.rows[0]), currency: publicConfig().currency });
    } catch {
      res.status(503).json({ error: 'Could not check booking status. Please try again.' });
    }
  });

  app.get('/api/availability', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let nights;
    try { nights = dateRange(req.query.checkIn, req.query.checkOut); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try {
      const rooms = await pool.query(`SELECT r.* FROM rooms r WHERE r.price_per_night IS NOT NULL AND r.max_occupancy IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM bookings b WHERE (b.room_id = r.id OR (b.room_id IS NULL AND b.floor_number = r.floor_number))
        AND b.status IN ('pending', 'confirmed')
        AND b.check_in < $2::date AND b.check_out > $1::date
      ) ORDER BY r.room_number`, [req.query.checkIn, req.query.checkOut]);
      res.json({ success: true, data: rooms.rows, nights });
    } catch (err) {
      console.error('Availability lookup failed:', err.message);
      res.status(503).json({ error: 'Could not check availability. Please try again.' });
    }
  });

  app.get('/api/floors', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const filtered = req.query.checkIn !== undefined || req.query.checkOut !== undefined;
    if (filtered) {
      try { dateRange(req.query.checkIn, req.query.checkOut); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }
    try {
      const result = await pool.query(`SELECT r.*, ${filtered ? `NOT EXISTS (
        SELECT 1 FROM bookings b WHERE b.floor_number = r.floor_number
        AND b.status IN ('pending', 'confirmed') AND b.check_in < $2::date AND b.check_out > $1::date
      )` : 'TRUE'} AS available FROM rooms r ORDER BY floor_number, room_number`,
      filtered ? [req.query.checkIn, req.query.checkOut] : []);
      const floors = [1, 2].map(number => {
        const summary = floorSummary(result.rows, number);
        return summary && { ...summary, available: summary.price_per_night !== null && summary.max_occupancy !== null && result.rows.filter(room => room.floor_number === number).every(room => room.available) };
      }).filter(Boolean);
      res.json({ success: true, data: floors });
    } catch { res.status(503).json({ error: 'Could not load floors. Please retry.' }); }
  });

  app.post('/api/bookings', sameOrigin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let nights;
    try { validateGuest(req.body); nights = dateRange(req.body.checkIn, req.body.checkOut); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const b = req.body;
    if (b.paymentChoice !== undefined && !['advance', 'full'].includes(b.paymentChoice)) return res.status(400).json({ error: 'Choose advance or full payment.' });
    let client;
    let committed = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Serialize retries of the same request. A network retry never creates another hold.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [b.requestKey]);
      const existing = await client.query(`SELECT *, check_in::text AS check_in, check_out::text AS check_out
        FROM bookings WHERE request_key = $1`, [b.requestKey]);
      let booking = existing.rows[0];
      if (booking && (booking.room_id !== (b.roomId || null) || (!b.roomId && booking.floor_number !== b.floorNumber) || booking.check_in !== b.checkIn || booking.check_out !== b.checkOut ||
        booking.guest_name !== b.guestName.trim() || booking.guest_email !== b.guestEmail.trim() ||
        booking.guest_phone !== b.guestPhone.trim() || booking.guest_type !== b.guestType ||
        booking.guest_identity !== b.guestIdentity.trim().toUpperCase() || booking.guest_count !== b.guestCount || booking.payment_choice !== (b.paymentChoice || 'advance'))) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This request reference was already used. Please start a new request.' });
      }
      let floorNumber = b.floorNumber;
      if (b.roomId) {
        const lookup = await client.query('SELECT floor_number FROM rooms WHERE id = $1', [b.roomId]);
        floorNumber = lookup.rows[0]?.floor_number;
      }
      if (![1, 2].includes(floorNumber)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'The selected accommodation no longer exists.' });
      }
      await client.query('SELECT pg_advisory_xact_lock(72100, $1)', [floorNumber]);
      const roomResult = await client.query(b.roomId ? 'SELECT * FROM rooms WHERE id = $1 AND floor_number = $2 FOR UPDATE' :
        'SELECT * FROM rooms WHERE floor_number = $1 ORDER BY id FOR UPDATE', b.roomId ? [b.roomId, floorNumber] : [floorNumber]);
      if (!roomResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'The selected room no longer exists.' });
      }
      const room = b.roomId ? roomResult.rows[0] : floorSummary(roomResult.rows, floorNumber);
      if (!booking) {
        if (room.price_per_night == null || room.max_occupancy == null) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Rates or guest capacity for this accommodation are still being prepared. Please contact reception.' });
        }
        const totalCents = Math.round(Number(room.price_per_night) * 100) * nights;
        if (!Number.isSafeInteger(totalCents) || totalCents > 9999999999) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'This stay exceeds the supported booking total. Contact reception.' });
        }
        if (b.guestCount > room.max_occupancy) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `This accommodation accepts up to ${room.max_occupancy} guests.` });
        }
        const conflict = await client.query(`SELECT id FROM bookings WHERE floor_number = $1
          AND ($4::uuid IS NULL OR room_id IS NULL OR room_id = $4::uuid)
          AND status IN ('pending', 'confirmed') AND check_in < $3::date AND check_out > $2::date LIMIT 1`,
        [floorNumber, b.checkIn, b.checkOut, b.roomId || null]);
        if (conflict.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'The selected room or floor is reserved for these dates. Choose different dates or accommodation.' });
        }
        const result = await client.query(`INSERT INTO bookings
          (room_id, guest_name, guest_email, guest_phone, guest_count, check_in, check_out,
           total_price, status, hold_expires_at, request_key, payment_choice, advance_percent, floor_number, guest_type, guest_identity)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NULL,$9,$10,$11,$12,$13,$14)
          RETURNING *, check_in::text AS check_in, check_out::text AS check_out`,
        [b.roomId || null, b.guestName.trim(), b.guestEmail.trim(), b.guestPhone.trim(), b.guestCount,
          b.checkIn, b.checkOut, (totalCents / 100).toFixed(2), b.requestKey, b.paymentChoice || 'advance', advancePercent(), floorNumber,
          b.guestType, b.guestIdentity.trim().toUpperCase()]);
        booking = result.rows[0];
        await client.query('INSERT INTO booking_notifications (booking_id) VALUES ($1)', [booking.id]);
      }
      await client.query('COMMIT');
      committed = true;
      res.status(201).json({ success: true, booking,
        payment: paymentSummary(booking),
        statusUrl: `/booking-status.html#${booking.status_token}`,
        whatsappUrl: booking.status === 'pending' ? whatsappUrl(booking, room) : null,
        emailNotification: emailConfigured() ? 'queued' : 'not_configured',
        message: 'Request saved. Staff confirmation is required.' });
    } catch (err) {
      if (client && !committed) await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23P01') return res.status(409).json({ error: 'Room is no longer available. Choose another room or dates.' });
      console.error('Booking request failed:', err.message);
      res.status(503).json({ error: 'Could not save your request. Please retry; your reference prevents duplicate bookings.' });
    } finally { if (client) client.release(); }
  });

  app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(`SELECT COUNT(*) FILTER (WHERE sent_at IS NULL) AS unsent,
        COUNT(*) FILTER (WHERE sent_at IS NULL AND (attempts >= 8 OR created_at <= NOW() - INTERVAL '23 hours')) AS failed
        FROM booking_notifications`);
      res.json({ emailConfigured: emailConfigured(), whatsappConfigured: Boolean(publicConfig().whatsappNumber),
        bankConfigured: ['BANK_NAME', 'BANK_ACCOUNT_NAME', 'BANK_ACCOUNT_NUMBER'].every(key => process.env[key]?.trim()), ...result.rows[0] });
    } catch { res.status(503).json({ error: 'Could not load notification status.' }); }
  });

  app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(`SELECT b.*, b.check_in::text AS check_in, b.check_out::text AS check_out,
        ${bookingRoomColumns}, r.price_per_night,
        CASE WHEN n.sent_at IS NOT NULL THEN 'accepted by email provider'
          WHEN n.attempts >= 8 OR n.created_at <= NOW() - INTERVAL '23 hours' THEN 'failed'
          WHEN n.last_error IS NOT NULL THEN 'retrying' ELSE 'queued' END AS email_status
        FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
        LEFT JOIN booking_notifications n ON n.booking_id = b.id ORDER BY b.created_at DESC`);
      res.json({ success: true, data: result.rows.map(booking => ({ ...booking,
        payment: paymentSummary(booking), bank_details_whatsapp_url: bankDetailsUrl(booking),
        confirmation_whatsapp_url: confirmationWhatsappUrl(booking) })) });
    } catch { res.status(503).json({ error: 'Could not load bookings. Please retry.' }); }
  });

  app.patch('/api/admin/bookings/:id/payment', requireAdmin, async (req, res) => {
    const { id } = req.params;
    let amount, previous;
    try {
      if (!UUID.test(id)) throw new Error('Invalid booking.');
      amount = cents(req.body.paidAmount);
      previous = cents(req.body.expectedPaidAmount);
      if (typeof req.body.reference !== 'string' || !req.body.reference.trim() || req.body.reference.length > 200) throw new Error('Enter the bank transfer reference or verification note (up to 200 characters).');
    } catch (err) { return res.status(400).json({ error: err.message }); }
    try {
      // One statement keeps the verified total and audit record atomic. Compare the
      // previous total so retries or another admin cannot overwrite a newer payment.
      const result = await pool.query(`WITH changed AS (
        UPDATE bookings SET paid_amount = $2, updated_at = NOW()
        WHERE id = $1 AND paid_amount = $3 AND paid_amount <> $2
          AND status IN ('pending', 'confirmed') AND total_price >= $2
        RETURNING *
      ), recorded AS (
        INSERT INTO booking_payment_records (booking_id, previous_amount, verified_amount, reference)
        SELECT id, $3, paid_amount, $4 FROM changed RETURNING booking_id
      ) SELECT changed.* FROM changed JOIN recorded ON recorded.booking_id = changed.id`,
      [id, (amount / 100).toFixed(2), (previous / 100).toFixed(2), req.body.reference.trim()]);
      if (!result.rowCount) return res.status(409).json({ error: 'Payment was unchanged, exceeds the total, or the booking changed. Refresh and review it before retrying.' });
      res.json({ success: true, payment: paymentSummary(result.rows[0]) });
    } catch { res.status(503).json({ error: 'Could not record payment. Refresh bookings before retrying.' }); }
  });

  app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!UUID.test(id) || !['confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Choose a valid booking and action.' });
    }
    try {
      // Expired/cancelled requests cannot be restored. Submit a fresh availability-checked request.
      const result = await pool.query(`UPDATE bookings SET status = $2, updated_at = clock_timestamp()
        WHERE id = $1 AND (status = $2 OR
          ($2 = 'confirmed' AND status = 'pending' AND paid_amount >= CEIL(total_price * advance_percent) / 100) OR
          ($2 = 'cancelled' AND status IN ('pending', 'confirmed')))
        RETURNING *, check_in::text AS check_in, check_out::text AS check_out,
          COALESCE((SELECT room_number FROM rooms WHERE rooms.id = bookings.room_id), CASE floor_number WHEN 1 THEN '1st Floor' ELSE '2nd Floor' END) AS room_number,
          COALESCE((SELECT room_type FROM rooms WHERE rooms.id = bookings.room_id), 'Entire floor') AS room_type`, [id, status]);
      if (!result.rowCount) return res.status(409).json({ error: 'Cannot update booking. Verify and record the required advance before confirming. Cancelled or expired requests need a new booking.' });
      res.json({ success: true, data: result.rows[0],
        confirmationWhatsappUrl: confirmationWhatsappUrl(result.rows[0]) });
    } catch (err) {
      if (err.code === '23P01') return res.status(409).json({ error: 'This room is already reserved for those dates.' });
      res.status(503).json({ error: 'Could not update booking. Please retry.' });
    }
  });
}

function startBookingWorkers(pool) {
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await require('./notifications').processNotifications(pool);
    } catch (err) { console.error('Booking background task failed:', err.message); }
    finally { busy = false; }
  }
  void tick();
  const timer = setInterval(tick, 15000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { registerBookings, startBookingWorkers };
