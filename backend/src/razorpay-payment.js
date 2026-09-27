const crypto = require('crypto');

function paymentSignature(orderId, paymentId, keySecret) {
  return crypto
    .createHmac('sha256', String(keySecret || ''))
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  const received = String(signature || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(received) || !orderId || !paymentId || !keySecret) return false;

  const expected = paymentSignature(orderId, paymentId, keySecret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = { paymentSignature, verifyPaymentSignature };
