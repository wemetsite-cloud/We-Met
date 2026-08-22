const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const config = require('../config');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const createRateLimit = require('../request-limit');
const { verifyPaymentSignature } = require('../razorpay-payment');

const router = express.Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_PATTERN = /^order_[A-Za-z0-9]{6,64}$/;
const PAYMENT_PATTERN = /^pay_[A-Za-z0-9]{6,64}$/;

const createOrderLimit = createRateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'Too many checkout attempts. Please wait and try again.',
  key: (req) => req.user?.id || req.ip,
});
const verifyPaymentLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many payment verification attempts. Please wait and try again.',
  key: (req) => req.user?.id || req.ip,
});

const razorpay = config.razorpay.enabled
  ? new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  })
  : null;

function checkoutReceipt(value) {
  const hint = String(value || 'checkout').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'checkout';
  return `wm_${hint}_${crypto.randomBytes(7).toString('hex')}`.slice(0, 40);
}

function providerStatus(error) {
  return Number(error?.statusCode || error?.status || error?.error?.statusCode || 0);
}

router.use(authenticate, requireRole('customer'));

router.post('/create-order', createOrderLimit, asyncHandler(async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Online checkout is not configured on the server.' });
  }

  const planId = String(req.body.planId || '').trim();
  const amount = Number(req.body.amount);
  const currency = String(req.body.currency || 'INR').trim().toUpperCase();
  if (!UUID_PATTERN.test(planId)) return res.status(400).json({ error: 'Choose a valid talk-time pack.' });
  if (!Number.isInteger(amount) || amount < 100) {
    return res.status(400).json({ error: 'Payment amount must be at least 100 paise.' });
  }
  if (currency !== 'INR') return res.status(400).json({ error: 'Only INR payments are supported.' });

  const planResult = await db.query(`
    SELECT id,name,price_paise,seconds
    FROM plans
    WHERE id=$1 AND active=true
  `, [planId]);
  const plan = planResult.rows[0];
  if (!plan) return res.status(404).json({ error: 'This talk-time pack is no longer available.' });
  if (Number(plan.price_paise) < 100) {
    return res.status(400).json({ error: 'Payment amount must be at least 100 paise.' });
  }
  if (amount !== Number(plan.price_paise)) {
    return res.status(400).json({ error: 'The pack price changed. Refresh the page and try again.' });
  }

  const receipt = checkoutReceipt(req.body.receipt);
  let order;
  try {
    order = await razorpay.orders.create({
      amount,
      currency,
      receipt,
      notes: {
        purpose: 'We Met talk-time',
        plan_id: plan.id,
      },
    });
  } catch (error) {
    const status = providerStatus(error);
    console.error('Razorpay order creation failed:', error?.error?.code || error?.message || status);
    if (status === 401) {
      return res.status(401).json({ error: 'Razorpay authentication failed. Check the server credentials.' });
    }
    return res.status(500).json({ error: 'The payment order could not be created. Please try again.' });
  }

  if (!ORDER_PATTERN.test(String(order?.id || ''))
      || Number(order.amount) !== amount
      || String(order.currency || '').toUpperCase() !== currency) {
    console.error('Razorpay returned an invalid order response.');
    return res.status(500).json({ error: 'The payment order could not be created. Please try again.' });
  }

  await db.query(`
    INSERT INTO razorpay_orders(
      customer_id,plan_id,plan_name,amount_paise,currency,seconds,
      receipt,razorpay_order_id,status
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'created')
  `, [
    req.user.id,
    plan.id,
    plan.name,
    amount,
    currency,
    Number(plan.seconds),
    receipt,
    order.id,
  ]);

  return res.status(201).json({
    order_id: order.id,
    amount: Number(order.amount),
    currency: String(order.currency),
    key_id: config.razorpay.keyId,
  });
}));

router.post('/verify-payment', verifyPaymentLimit, asyncHandler(async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Online checkout is not configured on the server.' });
  }

  const orderId = String(req.body.razorpay_order_id || '').trim();
  const paymentId = String(req.body.razorpay_payment_id || '').trim();
  const signature = String(req.body.razorpay_signature || '').trim();
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'Payment verification fields are missing.' });
  }
  if (!ORDER_PATTERN.test(orderId) || !PAYMENT_PATTERN.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(400).json({ error: 'Payment verification fields are invalid.' });
  }

  const storedResult = await db.query(`
    SELECT razorpay_order_id,amount_paise,currency,status,razorpay_payment_id
    FROM razorpay_orders
    WHERE razorpay_order_id=$1 AND customer_id=$2
  `, [orderId, req.user.id]);
  const storedOrder = storedResult.rows[0];
  if (!storedOrder) return res.status(404).json({ error: 'Payment order not found.' });

  const signatureMatches = verifyPaymentSignature({
    orderId: storedOrder.razorpay_order_id,
    paymentId,
    signature,
    keySecret: config.razorpay.keySecret,
  });
  if (!signatureMatches) {
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }

  let providerPayment;
  try {
    providerPayment = await razorpay.payments.fetch(paymentId);
  } catch (error) {
    const status = providerStatus(error);
    console.error('Razorpay payment status check failed:', error?.error?.code || error?.message || status);
    if (status === 401) {
      return res.status(401).json({ error: 'Razorpay authentication failed. Check the server credentials.' });
    }
    return res.status(500).json({ error: 'The payment status could not be confirmed. Please try again.' });
  }

  if (providerPayment?.order_id !== storedOrder.razorpay_order_id
      || Number(providerPayment?.amount) !== Number(storedOrder.amount_paise)
      || String(providerPayment?.currency || '').toUpperCase() !== storedOrder.currency) {
    return res.status(400).json({ error: 'Razorpay payment details do not match this order.' });
  }
  if (providerPayment.status === 'authorized') {
    return res.status(425).json({ error: 'Payment is still being captured. Please wait a moment.' });
  }
  if (providerPayment.status !== 'captured') {
    return res.status(409).json({ error: 'Razorpay has not marked this payment as successful.' });
  }

  const outcome = await db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [paymentId]);
    const found = await client.query(`
      SELECT * FROM razorpay_orders
      WHERE razorpay_order_id=$1 AND customer_id=$2
      FOR UPDATE
    `, [orderId, req.user.id]);
    const record = found.rows[0];
    if (!record) throw Object.assign(new Error('Payment order not found.'), { status: 404 });

    if (record.status === 'paid') {
      if (record.razorpay_payment_id !== paymentId) {
        throw Object.assign(new Error('This order was already paid with another payment.'), { status: 409 });
      }
      const balance = await client.query('SELECT balance_seconds FROM users WHERE id=$1', [req.user.id]);
      return {
        alreadyProcessed: true,
        order: record,
        balanceSeconds: Number(balance.rows[0].balance_seconds),
      };
    }

    const duplicate = await client.query(`
      SELECT id,customer_id FROM razorpay_orders
      WHERE razorpay_payment_id=$1
      FOR UPDATE
    `, [paymentId]);
    if (duplicate.rows[0]) {
      throw Object.assign(new Error('This Razorpay payment was already processed.'), { status: 409 });
    }

    const updated = await client.query(`
      UPDATE razorpay_orders
      SET razorpay_payment_id=$2,razorpay_signature=$3,status='paid',paid_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [record.id, paymentId, signature.toLowerCase()]);
    const balance = await client.query(`
      UPDATE users
      SET balance_seconds=balance_seconds+$2,updated_at=now()
      WHERE id=$1 AND role='customer'
      RETURNING balance_seconds
    `, [req.user.id, Number(record.seconds)]);
    if (!balance.rows[0]) throw Object.assign(new Error('Customer wallet not found.'), { status: 404 });

    await client.query(`
      INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
      VALUES($1,$2,'payment',$3,$4)
    `, [
      req.user.id,
      Number(record.seconds),
      `Razorpay · ${record.plan_name} · ${paymentId}`,
      record.id,
    ]);
    const title = 'Payment successful';
    const body = `${Math.round(Number(record.seconds) / 60)} minutes were added to your wallet.`;
    await client.query(
      'INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)',
      [req.user.id, title, body],
    );

    return {
      alreadyProcessed: false,
      order: updated.rows[0],
      balanceSeconds: Number(balance.rows[0].balance_seconds),
      notification: { title, body },
    };
  });

  if (outcome.notification) {
    await req.app.locals.notifyUser?.(req.user.id, {
      ...outcome.notification,
      url: './',
      tag: `we-met-razorpay-${outcome.order.id}`,
    });
  }

  return res.json({
    success: true,
    credited: !outcome.alreadyProcessed,
    already_processed: outcome.alreadyProcessed,
    order_id: orderId,
    payment_id: paymentId,
    seconds_added: Number(outcome.order.seconds),
    balance_seconds: outcome.balanceSeconds,
    message: outcome.alreadyProcessed
      ? 'This payment was already added to your wallet.'
      : `${outcome.order.plan_name} was added to your wallet.`,
  });
}));

module.exports = router;
