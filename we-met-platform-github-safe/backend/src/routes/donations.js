'use strict';

const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const config = require('../config');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const createRateLimit = require('../request-limit');
const { verifyPaymentSignature } = require('../razorpay-payment');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_PATTERN = /^order_[A-Za-z0-9]{6,64}$/;
const PAYMENT_PATTERN = /^pay_[A-Za-z0-9]{6,64}$/;
const MIN_PAISE = 1000; // ₹10
const MAX_PAISE = 1000000; // ₹10,000

const razorpay = config.razorpay.enabled ? new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
}) : null;
const createLimit = createRateLimit({ windowMs: 5 * 60 * 1000, max: 15,
  key: (req) => req.user?.id || req.ip,
  message: 'Too many donation attempts. Please try again later.' });
const verifyLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 40,
  key: (req) => req.user?.id || req.ip,
  message: 'Too many verification attempts. Please try again later.' });

function paymentErrorStatus(error) {
  return Number(error?.statusCode || error?.status || error?.error?.statusCode || 0);
}

router.post('/create', createLimit, asyncHandler(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Secure payments are not available right now.' });
  const employeeId = String(req.body.listenerId || '').trim();
  const amountPaise = Number(req.body.amountPaise);
  if (!UUID_PATTERN.test(employeeId)) return res.status(400).json({ error: 'Choose a valid listener.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise < MIN_PAISE || amountPaise > MAX_PAISE) {
    return res.status(400).json({ error: 'Enter an amount from ₹10 to ₹10,000.' });
  }
  const result = await db.query(`
    SELECT id,name FROM users
    WHERE id=$1 AND role='employee' AND status='active' AND listener_verification_status='approved'
      AND NOT EXISTS (
        SELECT 1 FROM customer_blocks WHERE customer_id=$2 AND employee_id=$1
      )
  `, [employeeId, req.user.id]);
  const listener = result.rows[0];
  if (!listener) return res.status(404).json({ error: 'This listener is not available.' });

  const receipt = `wm_tip_${crypto.randomBytes(12).toString('hex')}`;
  let order;
  try {
    order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: { purpose: 'We Met listener donation', listener_id: employeeId },
    });
  } catch (error) {
    console.error('Donation order creation failed:', error?.error?.code || error?.message);
    if (paymentErrorStatus(error) === 401) return res.status(503).json({ error: 'Payment setup needs attention. Please try later.' });
    return res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
  if (!ORDER_PATTERN.test(String(order?.id || '')) || Number(order.amount) !== amountPaise
      || String(order.currency || '').toUpperCase() !== 'INR') {
    return res.status(502).json({ error: 'Could not confirm the checkout order.' });
  }
  await db.query(`
    INSERT INTO listener_donation_orders(customer_id,employee_id,amount_paise,receipt,razorpay_order_id)
    VALUES($1,$2,$3,$4,$5)
  `, [req.user.id, employeeId, amountPaise, receipt, order.id]);

  res.status(201).json({
    order_id: order.id, amount: amountPaise, currency: 'INR',
    key_id: config.razorpay.keyId, listener_name: listener.name,
  });
}));

router.post('/verify', verifyLimit, asyncHandler(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Secure payments are not available right now.' });
  const orderId = String(req.body.razorpay_order_id || '').trim();
  const paymentId = String(req.body.razorpay_payment_id || '').trim();
  const signature = String(req.body.razorpay_signature || '').trim();
  if (!ORDER_PATTERN.test(orderId) || !PAYMENT_PATTERN.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(400).json({ error: 'Invalid payment verification details.' });
  }
  const stored = await db.query(`
    SELECT razorpay_order_id,amount_paise,status,razorpay_payment_id
    FROM listener_donation_orders WHERE razorpay_order_id=$1 AND customer_id=$2
  `, [orderId, req.user.id]);
  const existing = stored.rows[0];
  if (!existing) return res.status(404).json({ error: 'Donation order not found.' });
  if (!verifyPaymentSignature({ orderId: existing.razorpay_order_id, paymentId, signature,
    keySecret: config.razorpay.keySecret })) {
    return res.status(400).json({ error: 'Payment signature verification failed.' });
  }
  let payment;
  try {
    payment = await razorpay.payments.fetch(paymentId);
  } catch (error) {
    console.error('Donation payment status fetch failed:', error?.error?.code || error?.message);
    return res.status(502).json({ error: 'Could not confirm payment status. Keep your payment reference.' });
  }
  if (payment?.order_id !== orderId || Number(payment.amount) !== Number(existing.amount_paise)
      || String(payment.currency || '').toUpperCase() !== 'INR') {
    return res.status(400).json({ error: 'Payment details do not match your donation.' });
  }
  if (payment.status === 'authorized') {
    return res.status(425).json({ error: 'The payment is still processing. Please check again shortly.' });
  }
  if (payment.status !== 'captured') {
    return res.status(409).json({ error: 'The payment has not been captured.' });
  }

  const outcome = await db.transaction(async (client) => {
    const locked = await client.query(`
      SELECT * FROM listener_donation_orders
      WHERE razorpay_order_id=$1 AND customer_id=$2 FOR UPDATE
    `, [orderId, req.user.id]);
    const donation = locked.rows[0];
    if (!donation) throw Object.assign(new Error('Donation order not found.'), { status: 404 });
    if (donation.status === 'paid') {
      if (donation.razorpay_payment_id !== paymentId) {
        throw Object.assign(new Error('This donation already has another payment.'), { status: 409 });
      }
      return { donation, alreadyProcessed: true };
    }
    const updated = await client.query(`
      UPDATE listener_donation_orders
      SET status='paid',razorpay_payment_id=$2,razorpay_signature=$3,paid_at=now()
      WHERE id=$1 RETURNING *
    `, [donation.id, paymentId, signature.toLowerCase()]);
    await client.query(`
      INSERT INTO listener_wallet_transactions(employee_id,type,amount_paise,reference_id,payment_reference,note)
      VALUES($1,'donation_credit',$2,$3,$4,'Listener donation via Razorpay')
    `, [donation.employee_id, Number(donation.amount_paise), donation.id, paymentId]);
    const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
      .format(Number(donation.amount_paise) / 100);
    await client.query(`
      INSERT INTO notifications(user_id,title,body) VALUES
      ($1,'Donation received',$3),
      ($2,'Donation successful',$4)
    `, [donation.employee_id, donation.customer_id,
      `You received ${rupees} in your listener wallet.`,
      `Your ${rupees} donation was successful.`]);
    return { donation: updated.rows[0], alreadyProcessed: false, rupees };
  });
  if (!outcome.alreadyProcessed) {
    await Promise.allSettled([
      req.app.locals.notifyUser?.(outcome.donation.employee_id, {
        title: 'Donation received', body: `You received ${outcome.rupees} in your listener wallet.`,
        url: './', tag: `we-met-donation-listener-${outcome.donation.id}`,
      }),
      req.app.locals.notifyUser?.(outcome.donation.customer_id, {
        title: 'Donation successful', body: `Your ${outcome.rupees} donation was successful.`,
        url: './', tag: `we-met-donation-customer-${outcome.donation.id}`,
      }),
    ]);
  }
  res.json({ success: true, already_processed: outcome.alreadyProcessed,
    order_id: orderId, payment_id: paymentId, amount_paise: Number(outcome.donation.amount_paise),
    message: outcome.alreadyProcessed ? 'This donation was already credited.' : 'Donation sent successfully!' });
}));

module.exports = router;
