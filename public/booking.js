document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const form = $('bookingForm');
  const checkIn = $('checkIn');
  const checkOut = $('checkOut');
  const select = $('roomId');
  const guests = $('guestCount');
  const submit = $('submitBookingBtn');
  const help = $('roomHelpText');
  const quote = $('bookingQuote');
  const alert = $('formAlert');
  function updateIdentity() {
    const local = $('guestType').value === 'local';
    const foreign = $('guestType').value === 'foreign';
    $('identityLabel').textContent = local ? 'NIC number' : foreign ? 'Passport number' : 'NIC / Passport number';
    $('guestIdentity').pattern = local ? '(?:[0-9]{9}[vVxX]|[0-9]{12})' : '[A-Za-z0-9][A-Za-z0-9 \\-]{2,29}';
    $('guestIdentity').maxLength = local ? 12 : 30;
    $('guestIdentity').title = local ? '9 digits followed by V/X, or 12 digits' : 'Passport number: 3–30 letters or digits, with spaces or hyphens';
    $('identityHelp').textContent = local ? 'Enter your 12-digit NIC or old NIC ending in V/X.' : foreign ? 'Your passport number is required to book.' : 'NIC is required for Sri Lankan guests. Passport is required for foreign guests.';
  }
  $('guestType').addEventListener('change', () => { $('guestIdentity').value = ''; updateIdentity(); });
  updateIdentity();
  let config = { holdMinutes: null, currency: 'USD', whatsappNumber: null };
  let available = [];
  let selectedRoom;
  const params = new URLSearchParams(location.search);
  const requestedRoom = params.get('room');
  const requestedFloor = params.get('floor');
  if (!requestedRoom && requestedFloor === null) { location.replace('/rooms.html'); return; }
  const isFloor = requestedFloor !== null;
  const selectionId = isFloor ? `floor-${requestedFloor}` : requestedRoom;
  let checkedDates = '';
  let lookupVersion = 0;
  let submitting = false;
  let saved = false;
  let requestKey;
  let requestPayload;
  $('copyBookingLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('bookingStatusLink').href);
      $('copyLinkNotice').textContent = 'Private link copied. Save it to check your booking later.';
    } catch {
      $('copyLinkNotice').textContent = 'Copy the link using the View live booking status link above.';
    }
  });

  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: config.currency }).format(value);
  const dates = () => `${checkIn.value}/${checkOut.value}`;
  const validDates = () => checkIn.value && checkOut.value && checkIn.value >= checkIn.min && checkOut.value > checkIn.value;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  checkIn.min = today;
  checkIn.value = params.get('checkIn') || '';
  checkOut.value = params.get('checkOut') || '';
  const initialGuests = Number(params.get('guests') || 1);
  if (Number.isInteger(initialGuests) && initialGuests > 0) guests.value = initialGuests;
  if (checkIn.value) {
    const next = new Date(checkIn.value + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    checkOut.min = next.toISOString().slice(0, 10);
  }

  function showAlert(message, error = false) {
    alert.textContent = message;
    alert.className = `mb-6 p-4 rounded-xl text-sm font-medium ${error ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`;
  }

  function updateQuote() {
    const room = available.find(r => r.id === select.value);
    submit.disabled = submitting || saved || !room || checkedDates !== dates();
    if (!room || checkedDates !== dates()) {
      quote.textContent = 'Choose dates to check availability and see your total.';
      $('paymentQuote').textContent = 'Your advance and balance will appear after checking availability.';
      return;
    }
    const nights = (Date.parse(checkOut.value) - Date.parse(checkIn.value)) / 86400000;
    const totalCents = Math.round(Number(room.price_per_night) * 100) * nights;
    const advance = Math.ceil(totalCents * (config.advancePercent || 30) / 100) / 100;
    const due = $('paymentChoice').value === 'full' ? totalCents / 100 : advance;
    $('paymentQuote').textContent = `Advance (${config.advancePercent || 30}%): ${money(advance)} | Transfer: ${money(due)} | Balance after payment: ${money(totalCents / 100 - due)}`;
    guests.max = room.max_occupancy;
    quote.textContent = `${nights} night${nights === 1 ? '' : 's'} × ${money(room.price_per_night)} = ${money(Number(room.price_per_night) * nights)} · Up to ${room.max_occupancy} guests`;
  }

  async function loadRooms() {
    const version = ++lookupVersion;
    const selectedDates = dates();
    checkedDates = '';
    available = [];
    updateQuote();
    if (!selectedRoom) return;
    if (!validDates()) {
      help.textContent = (checkIn.value || checkOut.value) ? 'Choose valid dates. Check-out must be after check-in.' : 'Choose dates to check availability.';
      return;
    }
    help.textContent = 'Checking availability...';
    try {
      const response = await fetch((isFloor ? '/api/floors?' : '/api/availability?') + new URLSearchParams({ checkIn: checkIn.value, checkOut: checkOut.value }), { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not check availability. Change dates to retry.');
      if (version !== lookupVersion || selectedDates !== dates()) return;
      available = (result.data || []).filter(room => room.id === selectionId && (!isFloor || room.available));
      checkedDates = selectedDates;
      help.textContent = available.length ? 'Available for your dates. Availability is checked again when you book.' : (isFloor ? 'The entire floor is unavailable: one or more rooms are reserved. Try different dates or choose another floor.' : 'This room is unavailable for these dates. Try different dates or choose another room.');
      updateQuote();
    } catch (err) {
      if (version !== lookupVersion) return;
      help.textContent = err.message;
      showAlert(err.message, true);
    }
  }

  checkIn.addEventListener('change', () => {
    if (checkIn.value) {
      const next = new Date(checkIn.value);
      next.setUTCDate(next.getUTCDate() + 1);
      checkOut.min = next.toISOString().slice(0, 10);
      if (checkOut.value && checkOut.value <= checkIn.value) checkOut.value = '';
    }
    void loadRooms();
  });
  checkOut.addEventListener('change', loadRooms);
  select.addEventListener('change', updateQuote);
  $('paymentChoice').addEventListener('change', updateQuote);
  $('refreshRoomsBtn')?.addEventListener('click', loadRooms);
  $('newBookingBtn').addEventListener('click', () => { location.href = '/rooms.html'; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || saved || !form.reportValidity() || !validDates() || checkedDates !== dates()) return;
    const body = {
      ...(isFloor ? { floorNumber: Number(requestedFloor) } : { roomId: select.value }), checkIn: checkIn.value, checkOut: checkOut.value,
      guestName: $('guestName').value.trim(), guestEmail: $('guestEmail').value.trim(),
      guestPhone: $('guestPhone').value.trim(), guestCount: Number(guests.value), paymentChoice: $('paymentChoice').value,
      guestType: $('guestType').value, guestIdentity: $('guestIdentity').value.trim().toUpperCase()
    };
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== requestPayload) {
      requestKey = crypto.randomUUID();
      requestPayload = fingerprint;
    }
    body.requestKey = requestKey;
    let whatsappWindow = config.whatsappNumber ? window.open('about:blank', '_blank') : null;
    if (whatsappWindow) whatsappWindow.opener = null;
    submitting = true;
    updateQuote();
    $('btnSpinner').classList.remove('hidden');
      $('btnText').textContent = 'Saving your request…';
    try {
      const response = await fetch('/api/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) await loadRooms();
        throw new Error(result.error || 'Could not save your request. Please retry.');
      }
      saved = true;
      const booking = result.booking;
      showAlert(booking.status === 'pending' ? 'Booking request saved. Your accommodation is reserved pending staff confirmation.' : `This request is already ${booking.status}. Contact reception for help.`);
      $('bookingResult').classList.remove('hidden');
      $('bookingReference').textContent = booking.id;
      $('resultPayment').textContent = `Bank transfer: ${money(result.payment.amountDue)} due for your selection. Verified paid: ${money(result.payment.paidAmount)}. Balance: ${money(result.payment.balance)}. ` + (config.whatsappNumber ? 'Ask reception for bank details on WhatsApp and send your receipt there.' : 'Reception will provide bank details and instructions for your receipt.');
      $('resultStay').textContent = `${isFloor ? 'Entire ' + (booking.floor_number === 1 ? '1st Floor' : '2nd Floor') : 'Room ' + selectedRoom.room_number} | ${booking.check_in} to ${booking.check_out}`;
      $('resultStatus').textContent = `Status when saved: ${booking.status}. Use the link below for the latest status.`;
      $('bookingStatusLink').href = result.statusUrl;
      $('copyLinkNotice').textContent = 'Save this private link to check your status later. Only share it with people you trust.';
      $('resultTotal').textContent = `Total: ${money(booking.total_price)} · ${booking.guest_count} guest(s)`;
      const whatsapp = $('sendBookingWhatsapp');
      whatsapp.classList.toggle('hidden', !result.whatsappUrl || booking.status !== 'pending');
      if (result.whatsappUrl) whatsapp.href = result.whatsappUrl;
      if (result.whatsappUrl && booking.status === 'pending') {
        if (whatsappWindow && !whatsappWindow.closed) {
          whatsappWindow.location.replace(result.whatsappUrl);
          whatsappWindow = null;
        }
      } else if (whatsappWindow) { whatsappWindow.close(); whatsappWindow = null; }
      $('whatsappHelp').textContent = result.whatsappUrl ? 'Open WhatsApp and press Send to notify reception. This does not confirm the booking.' : 'Your request is saved for reception to review. Keep your private status link and check it for confirmation.';
      $('emailNotice').textContent = result.emailNotification === 'queued' ? 'A staff email notification is queued. You can also send your WhatsApp request below.' : 'Automatic email notifications are not configured yet.';
      form.querySelectorAll('input, select').forEach(input => input.disabled = true);
      $('bookingResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      if (whatsappWindow && !whatsappWindow.closed) whatsappWindow.close();
      showAlert(err.message || 'Connection failed. Retry with the same details to recover your request.', true);
    }
    finally {
      submitting = false;
      $('btnSpinner').classList.add('hidden');
      $('btnText').textContent = saved ? 'Request received' : (config.whatsappNumber ? 'Book via WhatsApp' : 'Send booking request');
      updateQuote();
    }
  });

  try {
    const response = await fetch('/api/config');
    if (response.ok) config = { ...config, ...await response.json() };
  } catch { /* Availability and submission still report their own connection errors. */ }
  if (config.contactPhone) {
    $('quickCallBtn').href = `tel:${config.contactPhone}`;
    $('quickCallBtn').hidden = false;
  }
  const quickWhatsapp = $('quickWhatsappBtn');
  quickWhatsapp.classList.toggle('hidden', !config.whatsappNumber);
  if (config.whatsappNumber) quickWhatsapp.href = `https://wa.me/${config.whatsappNumber}`;
  if (config.preview) showAlert('Interface preview only. Connect the database and register rooms to test live availability and save requests.');
  $('btnText').textContent = config.whatsappNumber ? 'Book via WhatsApp' : 'Send booking request';
  try {
    if ((isFloor && (!['1', '2'].includes(requestedFloor) || requestedRoom !== null)) || (!isFloor && !/^[a-f0-9-]{36}$/i.test(requestedRoom || ''))) throw new Error('Choose a room or entire floor from the rooms page to start your booking.');
    const response = await fetch(isFloor ? '/api/floors' : '/api/rooms', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error('Could not load this room. Please return to rooms and try again.');
    selectedRoom = (result.data || []).find(room => room.id === selectionId);
    if (!selectedRoom) throw new Error('This room is no longer listed. Please choose another room.');
    if (selectedRoom.price_per_night == null || selectedRoom.max_occupancy == null) throw new Error('Price or guest capacity is still being confirmed. Please contact reception or choose another room.');
    select.value = selectedRoom.id;
    guests.max = selectedRoom.max_occupancy;
    $('selectedRoomLabel').textContent = (isFloor ? 'Entire ' : 'Room ') + selectedRoom.room_number + ' - ' + selectedRoom.room_type + ' | ' + money(selectedRoom.price_per_night) + ' / night';
    if (isFloor) {
      $('selectedRoomLabel').textContent += ` | ${selectedRoom.room_count} rooms, up to ${selectedRoom.max_occupancy} guests`;
      document.querySelector('h2').textContent = 'Book Your Entire Floor';
    }
    void loadRooms();
  } catch (error) {
    $('selectedRoomLabel').textContent = 'Room unavailable';
    showAlert(error.message, true);
    form.querySelectorAll('input, select, button').forEach(element => element.disabled = true);
  }
});
