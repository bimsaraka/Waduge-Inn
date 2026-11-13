function floorLabel(number) {
  return Number(number) === 1 ? '1st Floor' : '2nd Floor';
}

function floorSummary(rooms, floorNumber) {
  const members = rooms.filter(room => room.floor_number === floorNumber);
  if (!members.length) return null;
  const ratesReady = members.every(room => room.price_per_night != null);
  const capacityReady = members.every(room => room.max_occupancy != null);
  return { id: `floor-${floorNumber}`, floor_number: floorNumber,
    room_number: floorLabel(floorNumber), room_type: 'Entire floor', room_count: members.length,
    price_per_night: ratesReady ? (members.reduce((sum, room) => sum + Math.round(Number(room.price_per_night) * 100), 0) / 100).toFixed(2) : null,
    max_occupancy: capacityReady ? members.reduce((sum, room) => sum + room.max_occupancy, 0) : null,
    has_kitchen: true,
    description: `Exclusive use of all ${members.length} rooms on the ${floorLabel(floorNumber)}, with a kitchen on this floor.` };
}

// LEFT JOIN keeps whole-floor bookings (which have no single room_id) visible.
const bookingRoomColumns = `COALESCE(r.room_number, CASE b.floor_number WHEN 1 THEN '1st Floor' ELSE '2nd Floor' END) AS room_number,
  COALESCE(r.room_type, 'Entire floor') AS room_type`;

module.exports = { floorLabel, floorSummary, bookingRoomColumns };
