(() => {
  const token = window.location.hash.slice(1);
  const $ = id => document.getElementById(id);
  let busy = false;
  let timer;
  const explanations = {
    pending: 'Your request is awaiting staff confirmation. A pending request is not a confirmed reservation.',
    confirmed: 'Your reservation is confirmed. We look forward to welcoming you!',
    cancelled: 'This booking has been cancelled. Contact reception or submit a new request to book again.',
    expired: 'The hold expired before confirmation. Please check availability and submit a new request.'
  };
  async function refresh() {
    if (busy) return;
    busy = true;
    $('refresh').disabled = true;
    clearTimeout(timer);
    try {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('This booking link is incomplete. Please use the full private link saved after booking.');
      const response = await fetch('/api/booking-status', {
        cache: 'no-store', headers: { 'X-Booking-Token': token }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not check your booking. Please retry.');
      const b = result.booking;
      $('details').hidden = false;
      $('notice').textContent = '';
      $('status').textContent = b.status.charAt(0).toUpperCase() + b.status.slice(1);
      $('explanation').textContent = explanations[b.status];
      $('summary').replaceChildren();
      const nights = (Date.parse(b.check_out) - Date.parse(b.check_in)) / 86400000;
      for (const [label, value] of [
        ['Reference', b.id], ['Accommodation', b.room_id ? `Room ${b.room_number} — ${b.room_type}` : `${b.room_number} — Entire floor`],
        ['Floor', b.floor_number === 1 ? '1st Floor' : '2nd Floor'],
        ['Check-in', b.check_in], ['Check-out', b.check_out], ['Nights', nights],
        ['Guests', b.guest_count], ['Total', `${result.currency} ${b.total_price}`],
        ['Payment method', 'Bank transfer via WhatsApp'],
        ['Payment selection', b.payment_choice === 'full' ? 'Full payment' : 'Advance payment'],
        ['Minimum advance', `${result.currency} ${result.payment.minimumAdvance}`],
        ['Verified paid', `${result.currency} ${result.payment.paidAmount}`],
        ['Remaining balance', `${result.currency} ${result.payment.balance}`],
        ['Payment status', result.payment.status.replaceAll('_', ' ')]
      ]) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        $('summary').append(dt, dd);
      }
      $('updated').textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
      if (b.status === 'pending' || b.status === 'confirmed') timer = setTimeout(refresh, 15000);
    } catch (error) {
      $('notice').textContent = error.message;
      $('details').hidden = true;
    } finally {
      busy = false;
      $('refresh').disabled = false;
    }
  }
  $('refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  void refresh();
})();
