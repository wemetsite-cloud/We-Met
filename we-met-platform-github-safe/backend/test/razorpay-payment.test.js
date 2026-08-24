const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentSignature, verifyPaymentSignature } = require('../src/razorpay-payment');

test('verifies the documented Razorpay order and payment HMAC', () => {
  const orderId = 'order_Test123456789';
  const paymentId = 'pay_Test123456789';
  const keySecret = 'test-only-secret';
  const signature = paymentSignature(orderId, paymentId, keySecret);

  assert.equal(signature.length, 64);
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature, keySecret }), true);
});

test('rejects changed payment fields and malformed signatures', () => {
  const orderId = 'order_Test123456789';
  const paymentId = 'pay_Test123456789';
  const keySecret = 'test-only-secret';
  const signature = paymentSignature(orderId, paymentId, keySecret);

  assert.equal(verifyPaymentSignature({
    orderId,
    paymentId: 'pay_Changed123456',
    signature,
    keySecret,
  }), false);
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature: 'invalid', keySecret }), false);
});
