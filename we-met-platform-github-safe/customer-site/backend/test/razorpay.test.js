const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'test-jwt-secret-that-is-longer-than-forty-eight-characters-123456789',
  ADMIN_PASSWORD: 'test-admin-password',
  DEMO_EMPLOYEE_PASSWORD: 'test-listener-password',
  PAYMENT_GATEWAY_MODE: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_example',
  RAZORPAY_KEY_SECRET: 'test_key_secret_123456789',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret_123456789',
});

const gateway = require('../src/razorpay');
const { creditCapturedPayment } = require('../src/razorpay-credit');

test('verifies Checkout signatures with order id and payment id', () => {
  const orderId = 'order_test_123';
  const paymentId = 'pay_test_456';
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  assert.equal(gateway.verifyPaymentSignature(orderId, paymentId, signature), true);
  assert.equal(gateway.verifyPaymentSignature(orderId, 'pay_changed', signature), false);
  assert.equal(gateway.verifyPaymentSignature(orderId, paymentId, 'bad'), false);
});

test('verifies webhook signatures against the unparsed body', () => {
  const rawBody = Buffer.from('{"event":"payment.captured"}', 'utf8');
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  assert.equal(gateway.verifyWebhookSignature(rawBody, signature), true);
  assert.equal(gateway.verifyWebhookSignature(Buffer.from('{}'), signature), false);
});

test('credits a captured order exactly through the wallet ledger', async () => {
  const order = {
    id: '86aeff4f-475b-42de-a531-788f02150b89',
    customer_id: '88f31357-bc37-41f9-b653-d34cfb430969',
    plan_name: 'Value',
    amount_paise: 9900,
    seconds: 600,
    currency: 'INR',
    razorpay_order_id: 'order_test_123',
    credited_at: null,
    status: 'created',
  };
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('SELECT * FROM razorpay_orders')) return { rows: [order] };
      if (sql.includes('INSERT INTO wallet_transactions')) return { rows: [{ id: 'ledger-id' }] };
      if (sql.includes('UPDATE users')) return { rows: [{ balance_seconds: 900 }] };
      if (sql.includes('INSERT INTO notifications')) {
        return { rows: [{ id: 'notice-id', title: 'Payment successful', body: '10 minutes were added.' }] };
      }
      if (sql.includes('UPDATE razorpay_orders')) {
        return { rows: [{ ...order, status: 'paid', razorpay_payment_id: 'pay_test_456', credited_at: new Date() }] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };

  const output = await creditCapturedPayment(client, {
    id: 'pay_test_456',
    order_id: 'order_test_123',
    amount: 9900,
    currency: 'INR',
    status: 'captured',
    captured: true,
    method: 'upi',
  });

  assert.equal(output.credited, true);
  assert.equal(output.order.status, 'paid');
  assert.equal(output.balanceSeconds, 900);
  assert.equal(calls.filter((sql) => sql.includes('UPDATE users')).length, 1);
  assert.equal(calls.filter((sql) => sql.includes('INSERT INTO wallet_transactions')).length, 1);
});

test('does not credit an order that was already credited', async () => {
  const order = {
    id: '86aeff4f-475b-42de-a531-788f02150b89',
    customer_id: '88f31357-bc37-41f9-b653-d34cfb430969',
    plan_name: 'Value',
    amount_paise: 9900,
    seconds: 600,
    currency: 'INR',
    razorpay_order_id: 'order_test_123',
    credited_at: new Date(),
    status: 'paid',
  };
  let queryCount = 0;
  const client = {
    async query(sql) {
      queryCount += 1;
      if (sql.includes('SELECT * FROM razorpay_orders')) return { rows: [order] };
      throw new Error('An already-credited order must not write again.');
    },
  };

  const output = await creditCapturedPayment(client, {
    id: 'pay_test_456',
    order_id: 'order_test_123',
    amount: 9900,
    currency: 'INR',
    status: 'captured',
    captured: true,
  });

  assert.equal(output.credited, false);
  assert.equal(queryCount, 1);
});
