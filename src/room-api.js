const { requireAdmin, sameOrigin } = require('./auth');
const { UUID } = require('./booking-utils');
const { cents } = require('./payments');

function roomDetails(body) {
  for (const [field, limit] of [['roomNumber', 50], ['roomType', 100]]) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > limit) throw new Error('Enter a room name and type within the supported length.');
  }
  if (![1, 2].includes(body.floorNumber)) throw new Error('Choose 1st Floor or 2nd Floor.');
  const capacity = body.maxOccupancy === '' || body.maxOccupancy == null ? null : body.maxOccupancy;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)) throw new Error('Guest capacity must be a whole number from 1 to 100.');
  const price = body.pricePerNight === '' || body.pricePerNight == null ? null : cents(body.pricePerNight);
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 3000)) throw new Error('Description must be at most 3000 characters.');
  const image = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (body.imageUrl != null && typeof body.imageUrl !== 'string') throw new Error('Enter a valid photo URL.');
  if (image && !/^\/assets\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(image)) {
    let url;
    try { url = new URL(image); } catch { throw new Error('Use an HTTPS photo URL or an image path under /assets/.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS photo URL without credentials.');
  }
  if (image.length > 2000 || image.includes('..')) throw new Error('Enter a valid photo URL.');
  return [body.roomNumber.trim(), body.roomType.trim(), price === null ? null : (price / 100).toFixed(2), capacity,
    body.description?.trim() || null, body.floorNumber, image || null];
}

function registerRooms(app, pool) {
  app.get('/api/rooms', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await pool.query('SELECT id, room_number, room_type, floor_number, price_per_night, max_occupancy, description, image_url, created_at FROM rooms ORDER BY floor_number, room_number');
      res.json({ success: true, data: result.rows });
    } catch { res.status(503).json({ error: 'Could not load rooms. Please retry.' }); }
  });
  app.post('/api/rooms', sameOrigin, requireAdmin, async (req, res) => {
    let values;
    try { values = roomDetails(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const result = await pool.query(`INSERT INTO rooms
        (room_number, room_type, price_per_night, max_occupancy, description, floor_number, image_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, values);
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      res.status(error.code === '23505' ? 409 : 503).json({ error: error.code === '23505' ? 'Room number is already registered.' : 'Could not save room. Please retry.' });
    }
  });
  app.patch('/api/rooms/:id', sameOrigin, requireAdmin, async (req, res) => {
    let values;
    try {
      if (!UUID.test(req.params.id)) throw new Error('Choose a valid room.');
      values = roomDetails(req.body);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(72100, 1)');
      await client.query('SELECT pg_advisory_xact_lock(72100, 2)');
      const result = await client.query(`UPDATE rooms SET room_number=$1, room_type=$2,
        price_per_night=$3, max_occupancy=$4, description=$5, floor_number=$6, image_url=$7, updated_at=NOW()
        WHERE id=$8 RETURNING *`, [...values, req.params.id]);
      await client.query('COMMIT');
      if (!result.rowCount) return res.status(404).json({ error: 'Room no longer exists.' });
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      const status = ['23505', '23514'].includes(error.code) ? 409 : 503;
      res.status(status).json({ error: error.code === '23505' ? 'Room number is already registered.' : error.code === '23514' ? 'Active reservations prevent changing this room’s floor.' : 'Could not update room. Please retry.' });
    } finally { client?.release(); }
  });
}
module.exports = { registerRooms, roomDetails };
