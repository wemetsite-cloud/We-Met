const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const gateway = require('../razorpay');
const { creditCapturedPayment } = require('../razorpay-credit');
const { authenticate, requireRole, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

function publicOrder(order) {
  return {
    gateway: 'razorpay',
    id: order.id,
    plan_id: order.plan_id,
    plan_name: order.plan_name,
    amount_paise: Number(order.amount_paise),
    seconds: Number(order.seconds),
    currency: order.currency,
    razorpay_order_id: order.razorpay_order_id,
    razorpay_payment_id: order.razorpay_payment_id,
    payment_method: order.payment_method,
    status: order.status,
    failure_description: order.failure_description,
    captured_at: order.captured_at,
    credited_at: order.credited_at,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

function checkoutContact(phone) {
  const original = String(phone || '').trim();
  const digits = original.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return '';
}

function razorpayApiStatus(error) {
  return Number(error?.statusCode || error?.status || error?.error?.statusCode || 0);
}

router.get('/orders', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT * FROM razorpay_orders
    WHERE customer_id=$1
    ORDER BY created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ orders: result.rows.map(publicOrder) });
}));

router.get('/orders/:id', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT * FROM razorpay_orders
    WHERE id=$1 AND customer_id=$2
  `, [req.params.id, req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Payment order not found.' });
  return res.json({ order: publicOrder(result.rows[0]) });
}));

router.post('/orders', asyncHandler(async (req, res) => {
  gateway.requireEnabled();
  const planId = String(req.body.planId || '');
  const planResult = await db.query(`
    SELECT id,name,price_paise,seconds
    FROM plans
    WHERE id=$1 AND active=true
  `, [planId]);
  const plan = planResult.rows[0];
  if (!plan) return res.status(404).json({ error: 'This talk-time pack is no longer available.' });
  if (!Number.isInteger(Number(plan.price_paise)) || Number(plan.price_paise) < 100) {
    return res.status(400).json({ error: 'Online payments must be at least ₹1.' });
  }

  const recentOrders = await db.query(`
    SELECT COUNT(*)::int AS count
    FROM razorpay_orders
    WHERE customer_id=$1 AND created_at > now() - interval '1 minute'
  `, [req.user.id]);
  if (Number(recentOrders.rows[0]?.count || 0) >= 5) {
    return res.status(429).json({ error: 'Too many checkout attempts. Please wait one minute and try again.' });
  }

  const receipt = `wm_${crypto.randomUUID().replace(/-/g, '')}`;
  let remoteOrder;
  try {
    remoteOrder = await gateway.createOrder({
      amount: Number(plan.price_paise),
      currency: 'INR',
      receipt,
      notes: {
        we_met_customer_id: req.user.id,
        we_met_plan_id: plan.id,
        we_met_plan_name: plan.name,
      },
    });
  } catch (error) {
    const gatewayStatus = razorpayApiStatus(error);
    console.error('Razorpay order creation failed:', error?.error?.code || gatewayStatus || 'gateway_error');
    if (gatewayStatus === 401) {
      return res.status(401).json({ error: 'The payment service could not authenticate. Contact support before retrying.' });
    }
    return res.status(500).json({ error: 'Secure checkout is temporarily unavailable. Please try again.' });
  }

  if (
    !remoteOrder?.id
    || Number(remoteOrder.amount) !== Number(plan.price_paise)
    || String(remoteOrder.currency).toUpperCase() !== 'INR'
  ) {
    throw Object.assign(new Error('Razorpay returned an invalid order.'), { status: 502 });
  }

  const result = await db.query(`
    INSERT INTO razorpay_orders(
      customer_id,plan_id,plan_name,amount_paise,seconds,currency,
      receipt,razorpay_order_id,status
    )
    VALUES($1,$2,$3,$4,$5,'INR',$6,$7,'created')
    RETURNING *
  `, [
    req.user.id,
    plan.id,
    plan.name,
    plan.price_paise,
    plan.seconds,
    receipt,
    remoteOrder.id,
  ]);

  const prefill = {
    name: req.user.name || '',
    email: req.user.email || '',
    contact: checkoutContact(req.user.phone),
  };

  res.status(201).json({
    keyId: config.razorpay.keyId,
    businessName: config.paymentPayeeName || config.appName,
    description: `${plan.name} · ${Math.round(Number(plan.seconds) / 60)} minutes`,
    image: `${config.publicUrl}/customer/assets/icon-192.png`,
    prefill,
    order: publicOrder(result.rows[0]),
  });
}));

router.post('/verify', asyncHandler(async (req, res) => {
  gateway.requireEnabled();
  const paymentId = String(req.body.razorpay_payment_id || '');
  const returnedOrderId = String(req.body.razorpay_order_id || '');
  const signature = String(req.body.razorpay_signature || '');
  if (!paymentId || !returnedOrderId || !signature) {
    return res.status(400).json({ error: 'The Razorpay payment response is incomplete.' });
  }

  const localResult = await db.query(`
    SELECT * FROM razorpay_orders
    WHERE razorpay_order_id=$1 AND customer_id=$2
  `, [returnedOrderId, req.user.id]);
  const localOrder = localResult.rows[0];
  if (!localOrder) return res.status(404).json({ error: 'This Razorpay order does not belong to your account.' });

  if (!gateway.verifyPaymentSignature(localOrder.razorpay_order_id, paymentId, signature)) {
    return res.status(400).json({ error: 'Payment verification failed. No minutes were added.' });
  }

  let payment;
  try {
    payment = await gateway.fetchPayment(paymentId);
  } catch (error) {
    const gatewayStatus = razorpayApiStatus(error);
    console.error('Razorpay payment fetch failed:', error?.error?.code || gatewayStatus || 'gateway_error');
    if (gatewayStatus === 401) {
      return res.status(401).json({ error: 'The payment service could not authenticate. No minutes were added.' });
    }
    return res.status(500).json({ error: 'Payment status could not be confirmed yet. It will update automatically.' });
  }
  if (String(payment?.id || '') !== paymentId) {
    throw Object.assign(new Error('Razorpay returned an invalid payment.'), { status: 502 });
  }

  const output = await db.transaction((client) => creditCapturedPayment(client, payment));
  if (!output.matched) return res.status(404).json({ error: 'The matching payment order was not found.' });

  if (output.notification) {
    await req.app.locals.notifyUser?.(localOrder.customer_id, {
      ...output.notification,
      url: './',
      tag: `we-met-payment-${localOrder.id}`,
    });
  }

  const captured = output.order.status === 'paid';
  return res.status(captured ? 200 : 202).json({
    order: publicOrder(output.order),
    balanceSeconds: output.balanceSeconds,
    message: captured
      ? 'Payment successful. Your talk-time was added automatically.'
      : 'Payment received. Waiting for Razorpay to confirm capture.',
  });
}));

module.exports = router;
