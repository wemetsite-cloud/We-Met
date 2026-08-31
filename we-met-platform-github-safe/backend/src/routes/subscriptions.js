'use strict';

const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const config = require('../config');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const createRateLimit = require('../request-limit');
const { listenerPublicName } = require('../subscription-access');

const router = express.Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const PAYMENT_PATTERN = /^pay_[A-Za-z0-9]{6,64}$/;

const createSubscriptionLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  message: 'Too many subscription attempts. Please wait and try again.',
  key: (req) => req.user?.id || req.ip,
});
const verifySubscriptionLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many subscription verification attempts. Please wait and try again.',
  key: (req) => req.user?.id || req.ip,
});

const razorpay = config.razorpay.enabled
  ? new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  : null;

function providerStatus(error) {
  return Number(error?.statusCode || error?.status || error?.error?.statusCode || 0);
}

function timestamp(value, fallback = null) {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : fallback;
}

function addOneMonth(value = new Date()) {
  const date = new Date(value);
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const daysInTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}

function paidPeriodEnd(providerSubscription, payment, fallback = new Date()) {
  const paidAt = timestamp(payment?.created_at, fallback);
  const currentEnd = timestamp(providerSubscription?.current_end);
  const nextCharge = timestamp(providerSubscription?.charge_at);
  if (currentEnd && currentEnd > paidAt) return currentEnd;
  if (nextCharge && nextCharge.getTime() > paidAt.getTime() + 24 * 60 * 60 * 1000) return nextCharge;
  return addOneMonth(paidAt);
}

function normalizeProviderStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['created', 'authenticated', 'active', 'paused', 'halted', 'pending', 'cancelled', 'completed', 'expired'].includes(status)) return status;
  return 'pending';
}

function checkoutSignatureMatches(paymentId, subscriptionId, signature) {
  if (!PAYMENT_PATTERN.test(paymentId) || !SUBSCRIPTION_PATTERN.test(subscriptionId) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.toLowerCase(), 'hex'));
}

function webhookSignatureMatches(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !Buffer.isBuffer(rawBody) || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature).toLowerCase(), 'hex'));
}

async function recordSubscriptionPayment(client, subscription, payment) {
  const paymentId = String(payment?.id || '');
  const amountPaise = Number(payment?.amount || 0);
  if (!PAYMENT_PATTERN.test(paymentId) || !Number.isInteger(amountPaise) || amountPaise <= 0) return { credited: false, captured: false };
  if (String(payment?.subscription_id || '') !== subscription.razorpay_subscription_id
      || String(payment?.currency || '') !== 'INR') return { credited: false, captured: false };

  const providerPaymentStatus = String(payment?.status || '').toLowerCase();
  const paymentStatus = ['authorized', 'captured', 'failed', 'refunded'].includes(providerPaymentStatus)
    ? providerPaymentStatus
    : 'authorized';
  const captured = paymentStatus === 'captured';
  const listenerCreditPaise = captured && amountPaise >= config.razorpay.subscriptionAmountPaise
    ? config.razorpay.listenerSubscriptionCreditPaise
    : 0;
  const paymentRecord = await client.query(`
    INSERT INTO listener_subscription_payments(
      subscription_id,customer_id,employee_id,razorpay_payment_id,
      amount_paise,listener_credit_paise,status,paid_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (razorpay_payment_id) DO UPDATE SET
      amount_paise=EXCLUDED.amount_paise,
      status=CASE
        WHEN listener_subscription_payments.status='captured' AND EXCLUDED.status='authorized' THEN 'captured'
        ELSE EXCLUDED.status
      END,
      listener_credit_paise=CASE
        WHEN listener_subscription_payments.listener_credited_at IS NOT NULL THEN listener_subscription_payments.listener_credit_paise
        ELSE EXCLUDED.listener_credit_paise
      END,
      paid_at=LEAST(listener_subscription_payments.paid_at,EXCLUDED.paid_at)
    RETURNING id,listener_credited_at,status
  `, [
    subscription.id,
    subscription.customer_id,
    subscription.employee_id,
    paymentId,
    amountPaise,
    listenerCreditPaise,
    paymentStatus,
    timestamp(payment?.created_at, new Date()),
  ]);

  const record = paymentRecord.rows[0];
  if (!record || record.listener_credited_at || record.status !== 'captured' || listenerCreditPaise <= 0) {
    return {
      credited: false,
      captured: record?.status === 'captured' && amountPaise >= config.razorpay.subscriptionAmountPaise,
      paymentStatus: record?.status || paymentStatus,
    };
  }
  await client.query(`
    INSERT INTO listener_wallet_transactions(
      employee_id,type,amount_paise,reference_id,note
    ) VALUES($1,'subscription_credit',$2,$3,$4)
    ON CONFLICT DO NOTHING
  `, [
    subscription.employee_id,
    listenerCreditPaise,
    record.id,
    `Exclusive membership credit · ${paymentId}`,
  ]);
  await client.query(`
    UPDATE listener_subscription_payments
    SET listener_credited_at=COALESCE(listener_credited_at,now()),listener_credit_paise=$2
    WHERE id=$1
  `, [record.id, listenerCreditPaise]);
  return { credited: true, captured: true, paymentStatus: 'captured', listenerCreditPaise };
}

async function updateSubscriptionFromProvider(client, record, providerSubscription, { eventAt = null } = {}) {
  const incomingEventAt = eventAt || new Date();
  const status = normalizeProviderStatus(providerSubscription?.status);
  const effectiveStatus = status;
  const fallbackEnd = effectiveStatus === 'active' ? addOneMonth(new Date()) : null;
  const start = timestamp(providerSubscription?.current_start, record.current_period_start || new Date());
  const end = timestamp(providerSubscription?.current_end, record.current_period_end || fallbackEnd);
  const paidCount = Math.max(Number(record.paid_count || 0), Number(providerSubscription?.paid_count || 0));

  const result = await client.query(`
    UPDATE listener_subscriptions
    SET status=$2,current_period_start=$3,current_period_end=$4,
        cancel_at_cycle_end=$5,paid_count=$6,last_event_at=$7,updated_at=now()
    WHERE id=$1 AND (last_event_at IS NULL OR last_event_at<=$7)
    RETURNING *
  `, [
    record.id,
    effectiveStatus,
    start,
    end,
    Boolean(providerSubscription?.cancel_at_cycle_end),
    paidCount,
    incomingEventAt,
  ]);
  return result.rows[0] || record;
}

async function activateCapturedPeriod(client, record, providerSubscription, payment) {
  const providerStatus = normalizeProviderStatus(providerSubscription?.status);
  const status = ['cancelled', 'completed'].includes(providerStatus) ? providerStatus : 'active';
  const start = timestamp(providerSubscription?.current_start)
    || timestamp(payment?.created_at, new Date());
  const end = paidPeriodEnd(providerSubscription, payment, start);
  const result = await client.query(`
    UPDATE listener_subscriptions
    SET status=$2,
        current_period_start=COALESCE(current_period_start,$3),
        current_period_end=CASE
          WHEN current_period_end IS NULL OR current_period_end<$4 THEN $4
          ELSE current_period_end
        END,
        cancel_at_cycle_end=COALESCE($5,cancel_at_cycle_end),
        paid_count=GREATEST(paid_count,$6,1),
        updated_at=now()
    WHERE id=$1 AND access_source='razorpay'
    RETURNING *
  `, [
    record.id,
    status,
    start,
    end,
    typeof providerSubscription?.cancel_at_cycle_end === 'boolean'
      ? providerSubscription.cancel_at_cycle_end
      : null,
    Number(providerSubscription?.paid_count || 1),
  ]);
  return result.rows[0] || record;
}

async function reconcileCustomerSubscriptions(customerId) {
  if (!razorpay) return;
  const candidates = await db.query(`
    SELECT * FROM listener_subscriptions
    WHERE customer_id=$1 AND access_source='razorpay'
      AND (
        status IN ('created','authenticated','pending','paused','halted')
        OR current_period_end IS NULL
        OR current_period_end<now()+interval '2 days'
      )
      AND updated_at<now()-interval '30 seconds'
    ORDER BY updated_at ASC
    LIMIT 10
  `, [customerId]);

  await Promise.all(candidates.rows.map(async (candidate) => {
    try {
      const providerSubscription = await razorpay.subscriptions.fetch(candidate.razorpay_subscription_id);
      await db.transaction(async (client) => {
        const locked = await client.query('SELECT * FROM listener_subscriptions WHERE id=$1 FOR UPDATE', [candidate.id]);
        if (!locked.rows[0] || locked.rows[0].access_source !== 'razorpay') return;
        await updateSubscriptionFromProvider(client, locked.rows[0], providerSubscription);
      });
    } catch (error) {
      console.warn('Razorpay subscription reconciliation skipped:', candidate.razorpay_subscription_id, error?.error?.code || error?.message || providerStatus(error));
    }
  }));
}

router.post('/create', authenticate, requireRole('customer'), createSubscriptionLimit, asyncHandler(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Razorpay subscriptions are not configured on the server.' });
  const employeeId = String(req.body.employeeId || '').trim();
  if (!UUID_PATTERN.test(employeeId)) return res.status(400).json({ error: 'Choose a valid listener.' });

  await reconcileCustomerSubscriptions(req.user.id);

  const prepared = await db.transaction(async (client) => {
    // This database lock works across all app instances and prevents two rapid
    // clicks from creating two recurring subscriptions for the same listener.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${req.user.id}:${employeeId}`]);
    const listenerResult = await client.query(`
      SELECT id,name,username,status,listener_verification_status
      FROM users
      WHERE id=$1 AND role='employee'
    `, [employeeId]);
    const listener = listenerResult.rows[0];
    if (!listener || listener.status !== 'active' || listener.listener_verification_status !== 'approved') {
      throw Object.assign(new Error('This listener is not available for subscriptions.'), { status: 404 });
    }

    const existing = await client.query(`
      SELECT * FROM listener_subscriptions
      WHERE customer_id=$1 AND employee_id=$2
        AND (
          (access_source='admin' AND status='active' AND revoked_at IS NULL)
          OR (
            access_source='razorpay'
            AND status IN ('active','cancelled','completed')
            AND current_period_end>now()
            AND (
              paid_count>0
              OR EXISTS(
                SELECT 1 FROM listener_subscription_payments payment
                WHERE payment.subscription_id=listener_subscriptions.id AND payment.status='captured'
              )
            )
          )
          OR (
            access_source='razorpay' AND status='created'
            AND created_at>now()-interval '20 minutes'
          )
          OR (
            access_source='razorpay' AND status IN ('authenticated','pending')
            AND created_at>now()-interval '30 minutes'
          )
        )
      ORDER BY updated_at DESC LIMIT 1
    `, [req.user.id, employeeId]);
    if (existing.rows[0]) return { listener, record: existing.rows[0], reused: true };

    let providerSubscription;
    try {
      providerSubscription = await razorpay.subscriptions.create({
        plan_id: config.razorpay.subscriptionPlanId,
        total_count: config.razorpay.subscriptionTotalCount,
        quantity: 1,
        customer_notify: 1,
        notes: {
          purpose: 'We Met exclusive listener membership',
          customer_id: req.user.id,
          listener_id: listener.id,
          listener_name: listenerPublicName(listener).slice(0, 120),
        },
      });
    } catch (error) {
      const status = providerStatus(error);
      console.error('Razorpay subscription creation failed:', error?.error?.code || error?.message || status);
      throw Object.assign(new Error(status === 401
        ? 'Razorpay authentication failed. Check the server credentials.'
        : 'The membership checkout could not be prepared. Please try again.'), { status: status === 401 ? 401 : 502 });
    }

    if (!SUBSCRIPTION_PATTERN.test(String(providerSubscription?.id || ''))
        || String(providerSubscription?.plan_id || '') !== config.razorpay.subscriptionPlanId) {
      throw Object.assign(new Error('Razorpay returned an invalid subscription response.'), { status: 502 });
    }

    await client.query(`
      INSERT INTO listener_subscriptions(
        customer_id,employee_id,razorpay_plan_id,razorpay_subscription_id,
        status,total_count,current_period_start,current_period_end
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      req.user.id,
      listener.id,
      config.razorpay.subscriptionPlanId,
      providerSubscription.id,
      normalizeProviderStatus(providerSubscription.status),
      Number(providerSubscription.total_count || config.razorpay.subscriptionTotalCount),
      timestamp(providerSubscription.current_start),
      timestamp(providerSubscription.current_end),
    ]);
    return { listener, record: { razorpay_subscription_id: providerSubscription.id }, reused: false };
  });

  if (prepared.reused && prepared.record.access_source === 'admin') {
    return res.status(409).json({ error: `Exclusive access with ${listenerPublicName(prepared.listener)} is already unlocked by the administrator.`, code: 'ALREADY_SUBSCRIBED' });
  }
  if (prepared.reused && ['active', 'cancelled', 'completed'].includes(prepared.record.status) && new Date(prepared.record.current_period_end) > new Date()) {
    return res.status(409).json({ error: `You already have an active membership with ${listenerPublicName(prepared.listener)}.`, code: 'ALREADY_SUBSCRIBED' });
  }
  if (prepared.reused && ['authenticated', 'pending'].includes(prepared.record.status)) {
    return res.status(202).json({
      processing: true,
      subscription_id: prepared.record.razorpay_subscription_id,
      listener: { id: prepared.listener.id, name: listenerPublicName(prepared.listener) },
      message: 'Your previous payment is still being confirmed. Refresh Exclusive in a moment.',
    });
  }

  res.status(prepared.reused ? 200 : 201).json({
    subscription_id: prepared.record.razorpay_subscription_id,
    key_id: config.razorpay.keyId,
    amount: config.razorpay.subscriptionAmountPaise,
    currency: 'INR',
    listener: { id: prepared.listener.id, name: listenerPublicName(prepared.listener) },
    reused: prepared.reused,
  });
}));

router.post('/verify', authenticate, requireRole('customer'), verifySubscriptionLimit, asyncHandler(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Razorpay subscriptions are not configured on the server.' });
  const paymentId = String(req.body.razorpay_payment_id || '').trim();
  const subscriptionId = String(req.body.razorpay_subscription_id || '').trim();
  const signature = String(req.body.razorpay_signature || '').trim();
  if (!checkoutSignatureMatches(paymentId, subscriptionId, signature)) {
    return res.status(400).json({ error: 'Membership payment signature verification failed.' });
  }

  const localResult = await db.query(`
    SELECT s.*,u.name,u.username
    FROM listener_subscriptions s
    JOIN users u ON u.id=s.employee_id
    WHERE s.razorpay_subscription_id=$1 AND s.customer_id=$2
  `, [subscriptionId, req.user.id]);
  const local = localResult.rows[0];
  if (!local) return res.status(404).json({ error: 'Membership record not found.' });

  let providerSubscription;
  let providerPayment;
  let fetchError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      [providerSubscription, providerPayment] = await Promise.all([
        razorpay.subscriptions.fetch(subscriptionId),
        razorpay.payments.fetch(paymentId),
      ]);
      fetchError = null;
      if (String(providerPayment?.status || '').toLowerCase() === 'captured') break;
    } catch (error) {
      fetchError = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }
  if (fetchError || !providerSubscription || !providerPayment) {
    console.error('Razorpay subscription verification fetch failed:', fetchError?.error?.code || fetchError?.message || providerStatus(fetchError));
    return res.status(502).json({ error: 'The membership payment status could not be confirmed. Please try again.', code: 'VERIFY_RETRY' });
  }

  if (String(providerSubscription?.plan_id || '') !== String(local.razorpay_plan_id || '')) {
    return res.status(400).json({ error: 'The Razorpay plan does not match this membership.' });
  }
  if (String(providerPayment?.subscription_id || '') !== subscriptionId
      || String(providerPayment?.currency || '') !== 'INR'
      || Number(providerPayment?.amount || 0) < config.razorpay.subscriptionAmountPaise) {
    return res.status(400).json({ error: 'The Razorpay payment does not match this ₹399 listener membership.' });
  }
  const outcome = await db.transaction(async (client) => {
    const locked = await client.query('SELECT * FROM listener_subscriptions WHERE id=$1 FOR UPDATE', [local.id]);
    const updated = await updateSubscriptionFromProvider(client, locked.rows[0], providerSubscription);
    const firstConfirmation = updated.last_payment_id !== paymentId;
    const credit = await recordSubscriptionPayment(client, updated, providerPayment);
    const active = credit.captured
      ? await activateCapturedPeriod(client, updated, providerSubscription, providerPayment)
      : updated;
    await client.query('UPDATE listener_subscriptions SET last_payment_id=$2,updated_at=now() WHERE id=$1', [active.id, paymentId]);
    if (!credit.captured) return { updated: active, credit, pending: true, notify: false };
    if (firstConfirmation) {
      await client.query(`
        INSERT INTO notifications(user_id,title,body)
        VALUES($1,'Exclusive membership active',$2),($3,'New exclusive member',$4)
      `, [
        req.user.id,
        `Photos and messages with ${listenerPublicName(local)} are now open. Calls still use your talk-time wallet.`,
        local.employee_id,
        'A customer subscribed to your exclusive profile.',
      ]);
    }
    return { updated: active, credit, pending: false, notify: firstConfirmation };
  });

  if (outcome.pending) {
    return res.status(202).json({
      success: false,
      pending: true,
      code: 'PAYMENT_PROCESSING',
      message: 'Payment received. Razorpay is still confirming it; access will unlock automatically.',
    });
  }

  if (outcome.notify) {
    await Promise.all([
      req.app.locals.notifyUser?.(req.user.id, {
        title: 'Exclusive membership active',
        body: `Photos and messages with ${listenerPublicName(local)} are now open.`,
        url: './',
        tag: `we-met-subscription-${local.id}`,
      }),
      req.app.locals.notifyUser?.(local.employee_id, {
        title: 'New exclusive member',
        body: 'A customer subscribed to your exclusive profile.',
        url: './',
        tag: `we-met-listener-subscription-${local.id}`,
      }),
    ]);
  }

  res.json({
    success: true,
    subscription: {
      id: outcome.updated.id,
      listenerId: local.employee_id,
      listenerName: listenerPublicName(local),
      status: 'active',
      currentPeriodEnd: outcome.updated.current_period_end,
    },
    message: `Exclusive access with ${listenerPublicName(local)} is active. Calls continue to use your talk-time balance.`,
  });
}));

router.post('/:id/cancel', authenticate, requireRole('customer'), asyncHandler(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Razorpay subscriptions are not configured on the server.' });
  const id = String(req.params.id || '');
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid membership.' });
  const result = await db.query(`
    SELECT * FROM listener_subscriptions
    WHERE id=$1 AND customer_id=$2 AND access_source='razorpay'
      AND status IN ('active','cancelled','completed') AND current_period_end>now()
  `, [id, req.user.id]);
  const subscription = result.rows[0];
  if (!subscription) return res.status(404).json({ error: 'Active membership not found.' });

  try {
    await razorpay.subscriptions.cancel(subscription.razorpay_subscription_id, { cancel_at_cycle_end: 1 });
  } catch (error) {
    console.error('Razorpay subscription cancellation failed:', error?.error?.code || error?.message || providerStatus(error));
    return res.status(502).json({ error: 'The membership could not be scheduled for cancellation. Please try again.' });
  }
  await db.query('UPDATE listener_subscriptions SET cancel_at_cycle_end=true,updated_at=now() WHERE id=$1', [subscription.id]);
  res.json({ ok: true, message: 'Auto-renewal is off. Access continues until the current paid period ends.' });
}));

async function webhook(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  if (!webhookSignatureMatches(req.body, signature)) return res.status(400).json({ error: 'Invalid webhook signature.' });

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid webhook payload.' }); }
  const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(req.body).digest('hex'));
  const eventType = String(event?.event || 'unknown');
  const providerSubscription = event?.payload?.subscription?.entity;
  const providerPayment = event?.payload?.payment?.entity;
  const subscriptionId = String(providerSubscription?.id || providerPayment?.subscription_id || '');

  try {
    const notification = await db.transaction(async (client) => {
      const insertedEvent = await client.query(`
        INSERT INTO razorpay_webhook_events(event_id,event_type)
        VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id
      `, [eventId, eventType]);
      if (!insertedEvent.rows[0]) return null;
      if (!SUBSCRIPTION_PATTERN.test(subscriptionId)) return null;

      const localResult = await client.query('SELECT * FROM listener_subscriptions WHERE razorpay_subscription_id=$1 FOR UPDATE', [subscriptionId]);
      const local = localResult.rows[0];
      if (!local) return null;
      if (providerSubscription && String(providerSubscription.plan_id || '') !== String(local.razorpay_plan_id || '')) return null;

      const eventAt = timestamp(event?.created_at, new Date());
      const updated = providerSubscription
        ? await updateSubscriptionFromProvider(client, local, providerSubscription, { eventAt })
        : local;
      const credit = providerPayment ? await recordSubscriptionPayment(client, updated, providerPayment) : { credited: false };
      const accessRecord = credit.captured
        ? await activateCapturedPeriod(client, updated, providerSubscription, providerPayment)
        : updated;
      if (providerPayment?.id) {
        await client.query('UPDATE listener_subscriptions SET last_payment_id=$2,updated_at=now() WHERE id=$1', [accessRecord.id, providerPayment.id]);
      }

      if (credit.credited) {
        await client.query(`
          INSERT INTO notifications(user_id,title,body)
          VALUES($1,'Subscription earning added',$2)
        `, [local.employee_id, `₹${(credit.listenerCreditPaise / 100).toFixed(2)} was added for a successful exclusive membership payment.`]);
      }
      return credit.credited ? {
        userId: local.employee_id,
        title: 'Subscription earning added',
        body: `₹${(credit.listenerCreditPaise / 100).toFixed(2)} was added to your listener wallet.`,
        tag: `we-met-subscription-payment-${providerPayment.id}`,
      } : null;
    });
    if (notification) await req.app.locals.notifyUser?.(notification.userId, { ...notification, url: './' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Razorpay subscription webhook failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

module.exports = {
  router,
  webhook,
  checkoutSignatureMatches,
  webhookSignatureMatches,
  recordSubscriptionPayment,
  reconcileCustomerSubscriptions,
};
