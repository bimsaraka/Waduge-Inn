// Owner-supplied inventory: 4 rooms on each floor, with prices supplied later.
// Run manually; never seeds rooms at ordinary application startup.
const pool = require('../src/db');

async function register() {
  await pool.ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(72100, 1)');
    await client.query('SELECT pg_advisory_xact_lock(72100, 2)');
    const existing = await client.query('SELECT room_number, floor_number FROM rooms ORDER BY floor_number, room_number FOR UPDATE');
    const downstairs = existing.rows.filter(room => room.floor_number === 1);
    const upstairs = existing.rows.filter(room => room.floor_number === 2);
    if (downstairs.some(room => !['1', '2', '3', '4'].includes(room.room_number)) || upstairs.some(room => !['201', '202', '203', '204'].includes(room.room_number))) {
      throw new Error('Inventory has other room labels; review before adding rooms to avoid duplicates.');
    }
    const additions = [
      ['1', 1, 'Room', null], ['2', 1, 'Room', null], ['3', 1, 'Room', null], ['4', 1, 'Room', null],
      ['201', 2, 'Triple Room', 3], ['202', 2, 'Triple Room', 3],
      ['203', 2, 'Single Room', 1], ['204', 2, 'Single Room', 1]
    ];
    for (const [number, floor, type, capacity] of additions) {
      const found = existing.rows.find(room => room.room_number === number);
      if (found && found.floor_number !== floor) throw new Error('Room label already belongs to another floor.');
      if (found) continue; // Keep all existing rates, descriptions and bookings intact.
      await client.query(`INSERT INTO rooms (room_number, floor_number, room_type, max_occupancy, price_per_night, description)
        VALUES ($1,$2,$3,$4,NULL,$5)`, [number, floor, type, capacity,
        floor === 1 ? 'Bed type to be confirmed. Kitchen on this floor.' : 'Kitchen on this floor.']);
    }
    const counts = await client.query('SELECT floor_number, COUNT(*)::int AS room_count FROM rooms GROUP BY floor_number ORDER BY floor_number');
    if (counts.rows.length !== 2 || counts.rows.some(floor => floor.room_count !== 4)) throw new Error('Expected exactly four rooms on each floor.');
    await client.query('COMMIT');
    console.log('Registered inventory: 1st Floor 4 rooms; 2nd Floor 2 Triple + 2 Single rooms.');
    console.log('Existing room details preserved. New room prices remain unset.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
register().catch(error => { console.error('Room registration failed:', error.code || error.message); process.exitCode = 1; }).finally(() => pool.end());
