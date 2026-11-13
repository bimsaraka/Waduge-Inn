document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const form = $('availabilityForm');
  if (!form) return;
  const grid = $('catalogResults');
  const status = $('catalogStatus');
  const arrival = $('arrival');
  const departure = $('departure');
  const guests = $('catalogGuests');
  const params = new URLSearchParams(location.search);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  arrival.min = today;
  arrival.value = params.get('checkIn') || '';
  departure.value = params.get('checkOut') || '';
  const requestedGuests = Number(params.get('guests') || 1);
  guests.value = Number.isInteger(requestedGuests) && requestedGuests > 0 && requestedGuests <= 1000 ? requestedGuests : 1;
  let currency = 'USD';
  let version = 0;
  let controller;
  let activeFloor = params.get('floor') === '2' ? 2 : 1;
  let summary = null;
  const tabs = [...document.querySelectorAll('[data-floor]')];
  function selectFloor(number) {
    activeFloor = number;
    tabs.forEach(tab => {
      const selected = Number(tab.dataset.floor) === number;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    grid.querySelectorAll('[data-floor-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.floorPanel) !== number; });
    if (summary) status.textContent = summary.preview ? 'Interface preview. Add real rooms through the live admin portal to enable bookings.' : `${number === 1 ? '1st' : '2nd'} Floor · ${summary.counts[number]} room or floor option${summary.counts[number] === 1 ? '' : 's'}${summary.filtered ? ' available for your dates' : ' · Choose dates to check availability'}.`;
    const url = new URL(location.href);
    url.searchParams.set('floor', number);
    history.replaceState(null, '', url);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectFloor(Number(tab.dataset.floor)));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectFloor(Number(tabs[next].dataset.floor));
      tabs[next].focus();
    });
  });
  selectFloor(activeFloor);
  function dateMinimum() {
    if (!arrival.value) { departure.min = today; return; }
    const next = new Date(arrival.value + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    departure.min = next.toISOString().slice(0, 10);
    if (departure.value && departure.value <= arrival.value) departure.value = '';
  }
  dateMinimum();
  function invalidate() {
    summary = null;
    version++; controller?.abort(); grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    $('checkAvailability').disabled = false; $('refreshRoomsBtn').disabled = false;
    status.textContent = 'Check availability to see results for these dates and guests.';
    status.className = ''; $('catalogEmpty').hidden = true;
  }
  arrival.addEventListener('change', () => { dateMinimum(); invalidate(); });
  departure.addEventListener('change', invalidate);
  guests.addEventListener('input', invalidate);
  const node = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  async function json(url, signal) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load rooms. Please retry.');
    return result;
  }
  function card(item, floor, filtered) {
    const ready = item.price_per_night != null && item.max_occupancy != null;
    const article = node('article', floor ? 'floor-card' : 'room-card');
    if (item.image_url) {
      const image = node('img', 'catalog-card-image'); image.src = item.image_url;
      image.alt = floor ? `Accommodation on the ${item.room_number}` : `Room ${item.room_number}: ${item.room_type}`;
      image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.replaceWith(node('div', 'catalog-photo-placeholder', 'Room photo coming soon')), { once: true });
      article.append(image);
    } else article.append(node('div', 'catalog-photo-placeholder', floor ? 'Your own floor. Your own space.' : 'Room photo coming soon'));
    const body = node('div', 'catalog-card-body');
    body.append(node('p', 'room-meta', `${floor ? `${item.room_count} rooms` : `Room ${item.room_number}`} · ${item.max_occupancy == null ? 'Capacity to be confirmed' : `Up to ${item.max_occupancy} guests`}`));
    body.append(node('h4', '', floor ? `Entire ${item.room_number}` : item.room_type));
    body.append(node('p', 'room-description', floor ? 'All rooms on this floor, exclusively for your group. Kitchen on this floor.' : item.description || 'Choose your dates and plan your stay with reception.'));
    body.append(node('p', 'room-price', item.price_per_night == null ? 'Price to be confirmed' : `${new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(item.price_per_night))} / night`));
    if (filtered) body.append(node('p', 'catalog-availability', 'Available for your dates'));
    const query = new URLSearchParams(floor ? { floor: item.floor_number } : { room: item.id });
    if (filtered) { query.set('checkIn', arrival.value); query.set('checkOut', departure.value); }
    query.set('guests', guests.value);
    const link = node('a', 'button', ready ? (floor ? 'Select entire floor' : 'Select room') : 'Enquire with reception');
    link.href = ready ? '/booking.html?' + query : '/#contact'; body.append(link); article.append(body);
    return article;
  }
  async function load(filtered) {
    if (filtered && !form.reportValidity()) return;
    if (filtered && (arrival.value < today || departure.value <= arrival.value)) { status.textContent = 'Choose future dates with check-out after check-in.'; return; }
    const current = ++version;
    summary = null;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    grid.replaceChildren(); grid.setAttribute('aria-busy', 'true'); $('catalogEmpty').hidden = true;
    $('checkAvailability').disabled = true; $('refreshRoomsBtn').disabled = true;
    status.className = ''; status.textContent = filtered ? 'Checking your dates…' : 'Loading rooms…';
    try {
      const query = new URLSearchParams({ checkIn: arrival.value, checkOut: departure.value });
      const [config, inventory, floors, availability] = await Promise.all([
        json('/api/config', signal), json('/api/rooms', signal), json('/api/floors' + (filtered ? '?' + query : ''), signal),
        filtered ? json('/api/availability?' + query, signal) : Promise.resolve(null)
      ]);
      if (current !== version) return;
      currency = config.currency || 'USD';
      const rooms = inventory.data || [];
      if (config.preview) status.textContent = 'Interface preview. Add real rooms through the live admin portal to enable bookings.';
      const availableIds = new Set((availability?.data || []).map(room => room.id));
      const counts = { 1: 0, 2: 0 };
      for (const floorNumber of [1, 2]) {
        let count = 0;
        const section = node('section', 'floor-section'); const floorGrid = node('div', 'floor-grid');
        section.id = `floorPanel${floorNumber}`;
        section.dataset.floorPanel = String(floorNumber);
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `floorTab${floorNumber}`);
        section.tabIndex = 0;
        section.hidden = floorNumber !== activeFloor;
        section.append(node('h2', 'floor-heading', floorNumber === 1 ? '1st Floor' : '2nd Floor'), floorGrid);
        const floorInfo = node('p', 'catalog-floor-info', floorNumber === 1 ? '4 rooms · Kitchen on this floor' : '4 rooms · 2 Triple rooms (3 guests each) + 2 Single rooms (1 guest each) · Kitchen on this floor');
        section.insertBefore(floorInfo, floorGrid);
        const floor = (floors.data || []).find(item => Number(item.floor_number) === floorNumber);
        const members = rooms.filter(room => Number(room.floor_number) === floorNumber);
        if (floor && (floor.max_occupancy == null ? !filtered : Number(floor.max_occupancy) >= Number(guests.value)) && (!filtered || floor.available)) {
          floorGrid.append(card({ ...floor, image_url: members.find(room => room.image_url)?.image_url }, true, filtered)); count++;
        }
        for (const room of members) {
          if ((room.max_occupancy == null ? filtered : Number(room.max_occupancy) < Number(guests.value)) || (filtered && !availableIds.has(room.id))) continue;
          floorGrid.append(card(room, false, filtered)); count++;
        }
        counts[floorNumber] = count;
        if (!count) {
          const empty = node('div', 'catalog-no-matches');
          const pendingRates = members.some(room => room.price_per_night == null || room.max_occupancy == null);
          empty.append(node('h3', '', members.length ? 'No matching stays on this floor' : 'Rooms on this floor are being prepared'), node('p', '', pendingRates ? 'Some room rates or guest capacities are still being confirmed. Contact reception, or select the other floor.' : members.length ? 'Try different dates or guest count, or select the other floor.' : 'Please check the other floor or contact reception for availability.'));
          const contact = node('a', 'button', 'Contact reception'); contact.href = '/#contact'; empty.append(contact); section.append(empty);
        }
        grid.append(section);
      }
      summary = { counts, filtered, preview: config.preview };
      selectFloor(activeFloor);
    } catch (error) {
      if (current !== version || error.name === 'AbortError') return;
      status.textContent = error.message || 'Could not load rooms. Please refresh to retry.'; status.className = 'catalog-error';
    } finally {
      if (current === version) { grid.setAttribute('aria-busy', 'false'); $('checkAvailability').disabled = false; $('refreshRoomsBtn').disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void load(true); });
  $('refreshRoomsBtn').addEventListener('click', () => { void load(Boolean(arrival.value || departure.value)); });
  void load(Boolean(arrival.value && departure.value));
});
