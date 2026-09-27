const crypto = require('crypto');

const ALLOWED_METHODS = new Set(['upi']);

function normaliseTransferReference(value) {
  const reference = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (reference.length < 6 || reference.length > 64 || !/^[A-Z0-9/:-]+$/.test(reference)) {
    return '';
  }
  return reference;
}

function checkoutReference() {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `WM-${date}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function encodeUpiValue(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function upiQuery(parameters) {
  return Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      let encodedValue = encodeUpiValue(value);
      // Keep the VPA separator literal, matching standard UPI QR/deep-link examples.
      if (key === 'pa') encodedValue = encodedValue.replace(/%40/gi, '@');
      return `${encodeUpiValue(key)}=${encodedValue}`;
    })
    .join('&');
}

function upiPaymentUri({ upiId, payeeName, amountPaise, reference, note }) {
  if (!upiId) return '';
  const query = upiQuery({
    pa: upiId,
    pn: payeeName,
    tr: reference,
    tn: note || `We Met ${reference}`,
    am: (Number(amountPaise) / 100).toFixed(2),
    cu: 'INR',
  });
  return `upi://pay?${query}`;
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

function publicSubmission(row) {
  return {
    method: row.payment_method === 'upi' ? 'upi_direct' : 'manual_transfer',
    id: row.id,
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    amount_paise: Number(row.amount_paise),
    seconds: Number(row.seconds),
    payment_method: row.payment_method,
    checkout_reference: row.checkout_reference,
    destination_last4: row.destination_last4,
    utr_reference: row.utr_reference,
    customer_note: row.customer_note,
    proof_available: Boolean(row.proof_size),
    status: row.status,
    admin_message: row.admin_message,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  ALLOWED_METHODS,
  checkoutReference,
  detectImageMime,
  normaliseTransferReference,
  publicSubmission,
  upiPaymentUri,
};
