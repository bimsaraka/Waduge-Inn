const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dateRange(checkIn, checkOut, today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date())) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(checkIn) || !valid(checkOut)) throw new Error('Choose valid check-in and check-out dates.');
  if (checkIn < today) throw new Error('Check-in cannot be in the past.');
  const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000;
  if (nights < 1 || nights > 365) throw new Error('Choose a stay between 1 and 365 nights.');
  return nights;
}

function publicConfig(env = process.env) {
  const number = (env.WHATSAPP_NUMBER || '').replace(/[\s+()-]/g, '');
  const phone = (env.PUBLIC_PHONE || '').replace(/[\s()-]/g, '');
  let mapsUrl = null;
  try {
    const url = new URL(env.PUBLIC_MAP_URL);
    if (url.protocol === 'https:' && !url.username && !url.password) mapsUrl = url.href;
  } catch { /* Only show directions once the property's location link is provided. */ }
  return {
    whatsappNumber: /^[1-9]\d{7,14}$/.test(number) ? number : null,
    holdMinutes: null,
    currency: /^[A-Z]{3}$/.test(env.CURRENCY || '') ? env.CURRENCY : 'USD',
    address: (env.PUBLIC_ADDRESS || '').trim() || 'Above Gregory Lake, Nuwara Eliya, Sri Lanka.',
    contactPhone: /^\+?[1-9]\d{7,14}$/.test(phone) ? phone : null,
    contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.PUBLIC_EMAIL || '') ? env.PUBLIC_EMAIL : null,
    mapsUrl
  };
}

function reviewUrl(id, env = process.env) {
  try {
    const base = new URL(env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    return new URL(`/admin?booking=${encodeURIComponent(id)}`, base.origin).href;
  } catch { return null; }
}

function whatsappUrl(booking, room, env = process.env) {
  const { whatsappNumber, currency } = publicConfig(env);
  if (!whatsappNumber) return null;
  const link = reviewUrl(booking.id, env);
  const message = [
    'Hello Waduge Inn! Please review my booking request.',
    `Reference: ${booking.id}`, `Name: ${booking.guest_name}`,
    `Room: ${room.room_number} — ${room.room_type}`,
    `Check-in: ${String(booking.check_in).slice(0, 10)}`,
    `Check-out: ${String(booking.check_out).slice(0, 10)}`,
    `Guests: ${booking.guest_count}`, `Total: ${currency} ${booking.total_price}`,
    `Payment: Bank transfer (${booking.payment_choice === 'full' ? 'full payment' : 'advance payment'})`,
    'Please send me your bank details and the amount to transfer. I will send the receipt here.',
    'This is a request; confirmation is required.',
    ...(link ? [`Staff review (admin login required): ${link}`] : [])
  ].join('\n');
  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
}

function validateGuest(body) {
  for (const [field, limit] of [['guestName', 150], ['guestEmail', 255], ['guestPhone', 50]]) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > limit) {
      throw new Error('Enter a valid name, email and phone number.');
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.guestEmail.trim())) throw new Error('Enter a valid email address.');
  if (!/^\+?[\d\s()-]{7,50}$/.test(body.guestPhone.trim())) throw new Error('Enter a valid phone number.');
  if (!['local', 'foreign'].includes(body.guestType)) throw new Error('Choose Sri Lankan or foreign guest.');
  const identity = typeof body.guestIdentity === 'string' ? body.guestIdentity.trim().toUpperCase() : '';
  if (body.guestType === 'local' && !/^(?:\d{9}[VX]|\d{12})$/.test(identity)) {
    throw new Error('Enter a valid NIC number: 9 digits followed by V/X, or 12 digits.');
  }
  if (body.guestType === 'foreign' && !/^[A-Z0-9][A-Z0-9 -]{2,29}$/.test(identity)) {
    throw new Error('A passport number is required for foreign guests (3–30 letters or digits, with spaces or hyphens).');
  }
  if (!Number.isInteger(body.guestCount) || body.guestCount < 1) throw new Error('Choose a valid number of guests.');
  const roomBooking = UUID.test(body.roomId || '') && body.floorNumber === undefined;
  const floorBooking = !body.roomId && [1, 2].includes(body.floorNumber);
  if ((!roomBooking && !floorBooking) || !UUID.test(body.requestKey || '')) throw new Error('Choose a valid room or entire floor. Refresh and try again.');
}

function whatsappPhone(value) {
  let number = String(value || '').replace(/[\s+()-]/g, '');
  if (number.startsWith('00')) number = number.slice(2);
  if (/^0\d{9}$/.test(number)) number = '94' + number.slice(1);
  return /^[1-9]\d{7,14}$/.test(number) ? number : null;
}

function confirmationWhatsappUrl(booking, env = process.env) {
  if (booking.status !== 'confirmed') return null;
  const number = whatsappPhone(booking.guest_phone);
  if (!number) return null;
  const message = [
    `Hello ${booking.guest_name}, your booking at Waduge Inn is confirmed!`,
    `Reference: ${booking.id}`, `Room: ${booking.room_number} - ${booking.room_type}`,
    `Check-in: ${booking.check_in}`, `Check-out: ${booking.check_out}`,
    `Guests: ${booking.guest_count}`, `Total: ${publicConfig(env).currency} ${booking.total_price}`,
    'We look forward to welcoming you!'
  ].join('\n');
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

module.exports = { UUID, dateRange, publicConfig, reviewUrl, whatsappUrl, validateGuest,
  whatsappPhone, confirmationWhatsappUrl };
