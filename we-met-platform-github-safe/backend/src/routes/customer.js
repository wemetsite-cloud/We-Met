const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { authenticate, requireRole, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowed.has(file.mimetype)) {
      return callback(Object.assign(new Error('Upload a PNG, JPEG or WebP payment screenshot.'), { status: 400 }));
    }
    return callback(null, true);
  },
});

function uploadPaymentProof(req, res, next) {
  proofUpload.single('proof')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The screenshot must be 5 MB or smaller.' });
    return res.status(error.status || 400).json({ error: error.message || 'The screenshot could not be uploaded.' });
  });
}

function validImageBytes(file) {
  const bytes = file?.buffer;
  if (!bytes || bytes.length < 12) return false;
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}

router.get('/history', asyncHandler(async (req, res) => {
  const [calls, wallet] = await Promise.all([
    db.query(
      `SELECT c.id,c.employee_id,c.status,c.started_at,c.ended_at,c.billed_seconds,
              c.end_reason,c.created_at,e.name employee_name,e.bio employee_bio
       FROM calls c JOIN users e ON e.id=c.employee_id
       WHERE c.customer_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
      [req.user.id],
    ),
    db.query(
      `SELECT id,seconds_delta,type,note,created_at
       FROM wallet_transactions WHERE customer_id=$1
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.id],
    ),
  ]);
  res.json({ calls: calls.rows, wallet: wallet.rows });
}));

router.post('/redeem', asyncHandler(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter a redeem code.' });

  const output = await db.transaction(async (client) => {
    const couponResult = await client.query('SELECT * FROM coupons WHERE code=$1 FOR UPDATE', [code]);
    const coupon = couponResult.rows[0];
    if (!coupon || !coupon.active) throw Object.assign(new Error('This redeem code is not valid.'), { status: 400 });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) throw Object.assign(new Error('This redeem code has expired.'), { status: 400 });
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) throw Object.assign(new Error('This redeem code has reached its usage limit.'), { status: 400 });

    const previous = await client.query('SELECT 1 FROM coupon_redemptions WHERE coupon_id=$1 AND customer_id=$2', [coupon.id, req.user.id]);
    if (previous.rows[0]) throw Object.assign(new Error('You have already used this redeem code.'), { status: 409 });

    await client.query('INSERT INTO coupon_redemptions(coupon_id,customer_id,seconds_added) VALUES($1,$2,$3)', [coupon.id, req.user.id, coupon.seconds]);
    await client.query('UPDATE coupons SET used_count=used_count+1 WHERE id=$1', [coupon.id]);
    const userResult = await client.query(
      'UPDATE users SET balance_seconds=balance_seconds+$2,updated_at=now() WHERE id=$1 RETURNING balance_seconds',
      [req.user.id, coupon.seconds],
    );
    await client.query(
      `INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
       VALUES($1,$2,'coupon',$3,$4)`,
      [req.user.id, coupon.seconds, coupon.label || coupon.code, coupon.id],
    );
    return { seconds: coupon.seconds, balanceSeconds: userResult.rows[0].balance_seconds };
  });

  res.json(output);
}));

router.get('/payments', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id,plan_id,plan_name,amount_paise,seconds,payee_upi_id,utr_reference,
           customer_note,status,admin_message,reviewed_at,created_at,updated_at
    FROM payment_submissions
    WHERE customer_id=$1
    ORDER BY created_at DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ payments: result.rows });
}));

router.post('/payments', uploadPaymentProof, asyncHandler(async (req, res) => {
  const planId = String(req.body.planId || '');
  const utrReference = String(req.body.utrReference || '').trim().slice(0, 100) || null;
  const customerNote = String(req.body.customerNote || '').trim().slice(0, 500) || null;
  if (!req.file || !validImageBytes(req.file)) {
    return res.status(400).json({ error: 'The selected file is not a valid PNG, JPEG or WebP screenshot.' });
  }

  const planResult = await db.query(`
    SELECT id,name,price_paise,seconds
    FROM plans
    WHERE id=$1 AND active=true
  `, [planId]);
  const plan = planResult.rows[0];
  if (!plan) return res.status(404).json({ error: 'This talk-time pack is no longer available.' });

  const limits = await db.query(`
    SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE created_at>now()-interval '24 hours')::int AS recent
    FROM payment_submissions
    WHERE customer_id=$1
  `, [req.user.id]);
  if (limits.rows[0].pending >= 3) {
    return res.status(429).json({ error: 'You already have three payment proofs waiting for review.' });
  }
  if (limits.rows[0].recent >= 10) {
    return res.status(429).json({ error: 'Too many payment submissions today. Try again later or contact support.' });
  }

  if (utrReference) {
    const duplicate = await db.query(`
      SELECT 1 FROM payment_submissions
      WHERE upper(trim(utr_reference))=upper(trim($1)) AND status IN ('pending','approved')
      LIMIT 1
    `, [utrReference]);
    if (duplicate.rows[0]) return res.status(409).json({ error: 'That UPI transaction reference was already submitted.' });
  }

  const result = await db.query(`
    INSERT INTO payment_submissions(
      customer_id,plan_id,plan_name,amount_paise,seconds,payee_upi_id,
      utr_reference,customer_note,proof_mime,proof_size,proof_data
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id,plan_id,plan_name,amount_paise,seconds,payee_upi_id,
              utr_reference,customer_note,status,created_at
  `, [
    req.user.id,
    plan.id,
    plan.name,
    plan.price_paise,
    plan.seconds,
    config.paymentUpiId,
    utrReference,
    customerNote,
    req.file.mimetype,
    req.file.size,
    req.file.buffer,
  ]);

  res.status(201).json({
    payment: result.rows[0],
    message: 'Payment proof submitted. Minutes will be added only after administrator approval.',
  });
}));

router.get('/payments/:id/proof', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT proof_mime,proof_data
    FROM payment_submissions
    WHERE id=$1 AND customer_id=$2
  `, [req.params.id, req.user.id]);
  const proof = result.rows[0];
  if (!proof) return res.status(404).json({ error: 'Payment screenshot not found.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(proof.proof_mime).send(proof.proof_data);
}));

router.get('/favorites', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT f.employee_id,f.created_at,u.name,u.bio,u.status
     FROM favorites f JOIN users u ON u.id=f.employee_id
     WHERE f.customer_id=$1 ORDER BY f.created_at DESC`,
    [req.user.id],
  );
  res.json({ favorites: result.rows });
}));

router.post('/favorites/:employeeId', asyncHandler(async (req, res) => {
  const employee = await db.query(`SELECT id FROM users WHERE id=$1 AND role='employee'`, [req.params.employeeId]);
  if (!employee.rows[0]) return res.status(404).json({ error: 'Listener not found.' });
  await db.query('INSERT INTO favorites(customer_id,employee_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.employeeId]);
  res.json({ ok: true });
}));

router.delete('/favorites/:employeeId', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM favorites WHERE customer_id=$1 AND employee_id=$2', [req.user.id, req.params.employeeId]);
  res.json({ ok: true });
}));

router.post('/reports', asyncHandler(async (req, res) => {
  const callId = req.body.callId || null;
  const reason = String(req.body.reason || '').trim().slice(0, 250);
  const details = String(req.body.details || '').trim().slice(0, 2000);
  const priority = req.body.priority === 'high' ? 'high' : 'normal';
  if (reason.length < 3) return res.status(400).json({ error: 'Describe the reason for the report.' });

  let targetId = null;
  if (callId) {
    const call = await db.query('SELECT employee_id FROM calls WHERE id=$1 AND customer_id=$2', [callId, req.user.id]);
    if (!call.rows[0]) return res.status(404).json({ error: 'Call not found.' });
    targetId = call.rows[0].employee_id;
  }

  const result = await db.query(
    `INSERT INTO reports(call_id,reporter_id,target_id,reason,details,priority)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [callId, req.user.id, targetId, reason, details || null, priority],
  );
  res.status(201).json({ report: result.rows[0] });
}));

router.get('/support', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM support_tickets WHERE customer_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ tickets: result.rows });
}));

router.post('/support', asyncHandler(async (req, res) => {
  const subject = String(req.body.subject || '').trim().slice(0, 120);
  const message = String(req.body.message || '').trim().slice(0, 3000);
  if (!subject || message.length < 5) return res.status(400).json({ error: 'Enter a subject and a clear message.' });
  const result = await db.query(
    'INSERT INTO support_tickets(customer_id,subject,message) VALUES($1,$2,$3) RETURNING *',
    [req.user.id, subject, message],
  );
  res.status(201).json({ ticket: result.rows[0] });
}));

router.get('/notifications', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: result.rows });
}));

router.post('/notifications/read', asyncHandler(async (req, res) => {
  await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
