const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const db = require('../db');
const config = require('../config');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const {
  ALLOWED_METHODS,
  checkoutReference,
  detectImageMime,
  normaliseTransferReference,
  publicSubmission,
  upiPaymentUri,
} = require('../manual-payment');

const router = express.Router();
const MAX_PROOF_BYTES = 3 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROOF_BYTES, files: 1, fields: 8 },
});

function paymentProof(req, res, next) {
  upload.single('proof')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'The payment screenshot must be 3 MB or smaller.' });
    }
    return res.status(400).json({ error: 'The payment screenshot could not be uploaded.' });
  });
}

function requireDirectUpi(req, res, next) {
  if (!config.upiPayment.enabled) {
    return res.status(409).json({ error: 'Direct UPI checkout is not currently enabled.' });
  }
  return next();
}

function paymentDetails(intent) {
  const payment = config.upiPayment;
  return {
    upiId: payment.upiId,
    payeeName: payment.payeeName,
    amountPaise: intent.amount_paise,
    reference: intent.checkout_reference,
    note: `We Met ${intent.checkout_reference}`,
  };
}

function publicIntent(intent) {
  const payment = config.upiPayment;
  return {
    id: intent.id,
    plan_id: intent.plan_id,
    plan_name: intent.plan_name,
    amount_paise: Number(intent.amount_paise),
    seconds: Number(intent.seconds),
    checkout_reference: intent.checkout_reference,
    expires_at: intent.expires_at,
    upi: {
      id: payment.upiId,
      payee_name: payment.payeeName,
    },
  };
}

router.use(authenticate, requireRole('customer'));

router.get('/submissions', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id,plan_id,plan_name,amount_paise,seconds,payment_method,
           checkout_reference,destination_last4,utr_reference,customer_note,
           proof_size,status,admin_message,reviewed_at,created_at,updated_at
    FROM payment_submissions
    WHERE customer_id=$1
    ORDER BY created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ submissions: result.rows.map(publicSubmission) });
}));

router.post('/intents', requireDirectUpi, asyncHandler(async (req, res) => {
  const planId = String(req.body.planId || '');
  const planResult = await db.query(`
    SELECT id,name,price_paise,seconds
    FROM plans
    WHERE id=$1 AND active=true
  `, [planId]);
  const plan = planResult.rows[0];
  if (!plan) return res.status(404).json({ error: 'This talk-time pack is no longer available.' });
  if (!Number.isInteger(Number(plan.price_paise)) || Number(plan.price_paise) < 100) {
    return res.status(400).json({ error: 'Payments must be at least ₹1.' });
  }

  const recent = await db.query(`
    SELECT COUNT(*)::int AS count
    FROM manual_payment_intents
    WHERE customer_id=$1 AND created_at > now() - interval '1 minute'
  `, [req.user.id]);
  if (Number(recent.rows[0]?.count || 0) >= 5) {
    return res.status(429).json({ error: 'Too many checkout attempts. Please wait one minute and try again.' });
  }

  let intentResult = await db.query(`
    SELECT * FROM manual_payment_intents
    WHERE customer_id=$1 AND plan_id=$2 AND submitted_at IS NULL AND expires_at>now()
    ORDER BY created_at DESC
    LIMIT 1
  `, [req.user.id, plan.id]);

  if (!intentResult.rows[0]) {
    intentResult = await db.query(`
      INSERT INTO manual_payment_intents(
        customer_id,plan_id,plan_name,amount_paise,seconds,checkout_reference,expires_at
      )
      VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(mins => $7::int))
      RETURNING *
    `, [
      req.user.id,
      plan.id,
      plan.name,
      plan.price_paise,
      plan.seconds,
      checkoutReference(),
      config.upiPayment.intentMinutes,
    ]);
  }

  const storedIntent = intentResult.rows[0];
  const intent = publicIntent(storedIntent);
  const qrPayload = upiPaymentUri(paymentDetails(storedIntent));
  const upiQrDataUrl = qrPayload
    ? await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 420,
      color: { dark: '#351522', light: '#FFFFFFFF' },
    })
    : '';

  return res.status(201).json({
    intent: { ...intent, upi_qr_data_url: upiQrDataUrl },
    notice: 'After paying, submit the successful UTR and payment screenshot for administrator review.',
  });
}));

router.post('/submissions', requireDirectUpi, paymentProof, asyncHandler(async (req, res) => {
  const intentId = String(req.body.intentId || '');
  const paymentMethod = String(req.body.paymentMethod || 'upi');
  const transferReference = normaliseTransferReference(req.body.utrReference);
  const customerNote = String(req.body.customerNote || '').trim().slice(0, 500) || null;

  if (!intentId) return res.status(400).json({ error: 'The payment checkout has expired. Start again.' });
  if (!ALLOWED_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'Only direct UPI payments are accepted in this checkout.' });
  if (!transferReference) {
    return res.status(400).json({ error: 'Enter the 6–64 character UTR, UPI transaction ID, or bank reference.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Attach the successful-payment screenshot.' });
  }
  const proofMime = detectImageMime(req.file.buffer);
  if (!proofMime) {
    return res.status(400).json({ error: 'The screenshot must be a genuine PNG, JPG, or WebP image.' });
  }
  const proofBuffer = req.file.buffer;

  const output = await db.transaction(async (client) => {
    const intentResult = await client.query(`
      SELECT * FROM manual_payment_intents
      WHERE id=$1 AND customer_id=$2
      FOR UPDATE
    `, [intentId, req.user.id]);
    const intent = intentResult.rows[0];
    if (!intent) throw Object.assign(new Error('This payment checkout was not found.'), { status: 404 });
    if (intent.submitted_at) throw Object.assign(new Error('This payment checkout was already submitted.'), { status: 409 });
    if (new Date(intent.expires_at) <= new Date()) {
      throw Object.assign(new Error('This payment checkout expired. Start again before submitting a reference.'), { status: 410 });
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [transferReference]);
    const duplicate = await client.query(`
      SELECT id FROM payment_submissions
      WHERE lower(regexp_replace(utr_reference, '\\s+', '', 'g'))=lower($1)
        AND status<>'declined'
      LIMIT 1
      FOR UPDATE
    `, [transferReference]);
    if (duplicate.rows[0]) {
      throw Object.assign(new Error('That transfer reference is already under review or was already approved.'), { status: 409 });
    }

    const payment = config.upiPayment;
    const inserted = await client.query(`
      INSERT INTO payment_submissions(
        customer_id,manual_intent_id,plan_id,plan_name,amount_paise,seconds,
        payment_method,checkout_reference,destination_last4,payee_upi_id,
        utr_reference,customer_note,proof_mime,proof_size,proof_data,status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')
      RETURNING *
    `, [
      req.user.id,
      intent.id,
      intent.plan_id,
      intent.plan_name,
      intent.amount_paise,
      intent.seconds,
      paymentMethod,
      intent.checkout_reference,
      null,
      payment.upiId,
      transferReference,
      customerNote,
      proofMime,
      proofBuffer?.length || null,
      proofBuffer,
    ]);

    await client.query('UPDATE manual_payment_intents SET submitted_at=now() WHERE id=$1', [intent.id]);
    const admins = await client.query(`SELECT id FROM users WHERE role='admin' AND status='active'`);
    const title = 'Payment awaiting verification';
    const body = `${req.user.name} submitted ${intent.plan_name} with a UTR and payment screenshot for review.`;
    await client.query(`
      INSERT INTO notifications(user_id,title,body)
      SELECT id,$1,$2 FROM users WHERE role='admin' AND status='active'
    `, [title, body]);
    return { payment: inserted.rows[0], adminIds: admins.rows.map((admin) => admin.id), title, body };
  });

  await Promise.all(output.adminIds.map((adminId) => req.app.locals.notifyUser?.(adminId, {
    title: output.title,
    body: output.body,
    url: '/admin/',
    tag: `we-met-manual-payment-${output.payment.id}`,
  })));

  return res.status(201).json({
    submission: publicSubmission(output.payment),
    message: 'UPI payment submitted for verification. Do not pay again while it is pending.',
  });
}));

module.exports = router;
