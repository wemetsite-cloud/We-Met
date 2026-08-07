const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const gateway = require('../razorpay');
const { creditCapturedPayment, updatePaymentState } = require('../razorpay-credit');
const { asyncHandler } = require('../middleware');

const router = express.Router();

router.post('/', asyncHandler(async (req, res) => {
  gateway.requireEnabled();
  const rawBody = req.body;
  const signature = String(req.get('x-razorpay-signature') || '');
  if (!Buffer.isBuffer(rawBody) || !gateway.verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid Razorpay webhook signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid Razorpay webhook payload.' });
  }

  const eventType = String(payload.event || 'unknown').slice(0, 120);
  const suppliedEventId = String(req.get('x-razorpay-event-id') || '').slice(0, 255);
  const eventId = suppliedEventId || `body_${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
  const payment = payload?.payload?.payment?.entity;

  const output = await db.transaction(async (client) => {
    const event = await client.query(`
      INSERT INTO razorpay_webhook_events(event_id,event_type)
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `, [eventId, eventType]);
    if (!event.rows[0]) return { duplicate: true };

    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      if (!payment) throw new Error('Captured-payment webhook is missing its payment entity.');
      return creditCapturedPayment(client, payment);
    }
    if (eventType === 'payment.authorized' || eventType === 'payment.failed') {
      if (!payment) throw new Error('Payment webhook is missing its payment entity.');
      return updatePaymentState(client, payment);
    }
    return { ignored: true };
  });

  if (output.notification && output.order) {
    await req.app.locals.notifyUser?.(output.order.customer_id, {
      ...output.notification,
      url: './',
      tag: `we-met-payment-${output.order.id}`,
    });
  }
  return res.json({ ok: true });
}));

module.exports = router;
