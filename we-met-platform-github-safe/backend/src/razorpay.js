const crypto = require('crypto');
const Razorpay = require('razorpay');
const config = require('./config');

let client;

function enabled() {
  return config.paymentGatewayMode === 'razorpay';
}

function requireEnabled() {
  if (!enabled()) {
    throw Object.assign(new Error('Secure online payments are not configured yet.'), { status: 503 });
  }
}

function getClient() {
  requireEnabled();
  if (!client) {
    client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return client;
}

function secureHexEqual(expected, received) {
  const left = Buffer.from(String(expected || '').toLowerCase(), 'utf8');
  const right = Buffer.from(String(received || '').toLowerCase(), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function paymentSignature(orderId, paymentId) {
  return crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  requireEnabled();
  if (!orderId || !paymentId || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  return secureHexEqual(paymentSignature(orderId, paymentId), signature);
}

function verifyWebhookSignature(rawBody, signature) {
  requireEnabled();
  if (!Buffer.isBuffer(rawBody) || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');
  return secureHexEqual(expected, signature);
}

async function createOrder(options) {
  return getClient().orders.create(options);
}

async function fetchPayment(paymentId) {
  return getClient().payments.fetch(paymentId);
}

module.exports = {
  enabled,
  requireEnabled,
  verifyPaymentSignature,
  verifyWebhookSignature,
  createOrder,
  fetchPayment,
};
