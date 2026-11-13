const { publicConfig, whatsappPhone } = require('./booking-utils');

function advancePercent(env = process.env) {
  const value = Number(env.ADVANCE_PERCENT || 30);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 30;
}

function cents(value) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(String(value))) throw new Error('Enter a valid amount with up to two decimal places.');
  return Math.round(Number(value) * 100);
}

function paymentSummary(b) {
  const total = cents(b.total_price);
  const paid = cents(b.paid_amount || 0);
  const minimum = Math.ceil(total * (b.advance_percent || 30) / 100);
  return { method: 'bank_transfer', advancePercent: b.advance_percent || 30,
    minimumAdvance: (minimum / 100).toFixed(2), paidAmount: (paid / 100).toFixed(2),
    balance: ((total - paid) / 100).toFixed(2),
    amountDue: (Math.max(0, (b.payment_choice === 'full' ? total : minimum) - paid) / 100).toFixed(2),
    status: paid >= total ? 'paid' : paid >= minimum ? 'advance_paid' : paid > 0 ? 'partially_paid' : 'unpaid' };
}

function bankDetailsUrl(b, env = process.env) {
  const phone = whatsappPhone(b.guest_phone);
  if (!phone || !['pending', 'confirmed'].includes(b.status) ||
      !['BANK_NAME', 'BANK_ACCOUNT_NAME', 'BANK_ACCOUNT_NUMBER'].every(key => env[key]?.trim())) return null;
  const p = paymentSummary(b);
  const currency = publicConfig(env).currency;
  const message = [
    `Hello ${b.guest_name}, bank transfer details for your Waduge Inn booking:`,
    `Reference: ${b.id}`, `Bank: ${env.BANK_NAME}`, `Branch: ${env.BANK_BRANCH || '-'}`,
    ...(b.room_id === null ? [`Accommodation: Entire ${b.floor_number === 1 ? '1st Floor' : '2nd Floor'}`] : []),
    `Account name: ${env.BANK_ACCOUNT_NAME}`, `Account number: ${env.BANK_ACCOUNT_NUMBER}`,
    `Total: ${currency} ${b.total_price}`, `Minimum advance (${p.advancePercent}%): ${currency} ${p.minimumAdvance}`,
    `Verified paid: ${currency} ${p.paidAmount}`, `Remaining balance: ${currency} ${p.balance}`,
    `Your selection: ${b.payment_choice === 'full' ? 'Full payment' : 'Advance payment'}`,
    `Amount due for your selection: ${currency} ${p.amountDue}`,
    'You may pay the advance or the full balance. Use your booking reference as the transfer reference.',
    'Send your receipt in this WhatsApp chat. Staff will verify the bank credit before confirming your reservation.'
  ].join('\n');
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

module.exports = { advancePercent, cents, paymentSummary, bankDetailsUrl };
