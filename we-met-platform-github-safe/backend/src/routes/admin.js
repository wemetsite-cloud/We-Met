const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hashPassword } = require('../auth');
const { authenticate, requireRole, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const VALID_USER_STATUSES = new Set(['active', 'blocked', 'suspended']);
const VALID_REPORT_STATUSES = new Set(['open', 'reviewing', 'closed']);
const VALID_SUPPORT_STATUSES = new Set(['open', 'replied', 'closed']);

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function integer(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

router.get('/dashboard', asyncHandler(async (_req, res) => {
  const [users, calls, reports, tickets, coupons, minutes, payments] = await Promise.all([
    db.query(`SELECT role, COUNT(*)::int AS count FROM users GROUP BY role`),
    db.query(`
      SELECT status, COUNT(*)::int AS count,
             COALESCE(SUM(billed_seconds), 0)::int AS seconds
      FROM calls
      GROUP BY status
    `),
    db.query(`SELECT COUNT(*)::int AS count FROM reports WHERE status <> 'closed'`),
    db.query(`SELECT COUNT(*)::int AS count FROM support_tickets WHERE status = 'open'`),
    db.query(`SELECT COUNT(*)::int AS count FROM coupons WHERE active = true`),
    db.query(`SELECT COALESCE(SUM(billed_seconds), 0)::bigint AS seconds FROM calls`),
    db.query(`SELECT COUNT(*)::int AS count FROM payment_submissions WHERE status='pending'`),
  ]);

  res.json({
    users: users.rows,
    calls: calls.rows,
    openReports: reports.rows[0].count,
    openTickets: tickets.rows[0].count,
    activeCoupons: coupons.rows[0].count,
    totalTalkSeconds: Number(minutes.rows[0].seconds),
    pendingPayments: payments.rows[0].count,
  });
}));

router.get('/users', asyncHandler(async (req, res) => {
  const role = String(req.query.role || '');
  const params = [];
  let where = '';

  if (['customer', 'employee', 'admin'].includes(role)) {
    params.push(role);
    where = 'WHERE role = $1';
  }

  const result = await db.query(`
    SELECT id, role, name, username, email, phone, bio,
           employee_code, upi_id, listener_availability, balance_seconds, status, suspended_until,
           suspension_reason, created_at
    FROM users
    ${where}
    ORDER BY created_at DESC
    LIMIT 1000
  `, params);

  res.json({ users: result.rows });
}));

router.post('/employees', asyncHandler(async (req, res) => {
  const name = text(req.body.name, 100);
  const username = text(req.body.username, 80).toLowerCase() || null;
  const email = text(req.body.email, 180).toLowerCase();
  const password = String(req.body.password || '');
  const phone = text(req.body.phone, 30) || null;
  const upiId = text(req.body.upiId, 120) || null;
  const bio = text(req.body.bio, 500) || null;
  const employeeCode = (text(req.body.employeeCode, 40) || `WM-L${Date.now().toString().slice(-6)}`)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');

  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return res.status(400).json({
      error: 'Enter a valid name, email address, and a password with at least 8 characters.',
    });
  }

  if (username && !/^[a-z0-9._-]{3,80}$/.test(username)) {
    return res.status(400).json({
      error: 'Username may contain only letters, numbers, dots, underscores, and hyphens.',
    });
  }

  try {
    const result = await db.query(`
      INSERT INTO users (
        role, name, username, email, phone, upi_id, bio, employee_code, password_hash
      )
      VALUES ('employee', $1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, role, name, username, email, phone, upi_id, bio,
                employee_code, listener_availability, status, created_at
    `, [
      name,
      username,
      email,
      phone,
      upiId,
      bio,
      employeeCode,
      await hashPassword(password),
    ]);

    res.status(201).json({ employee: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'That email address, username, or employee ID is already in use.',
      });
    }
    throw error;
  }
}));

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const status = req.body.status;
  const balanceSeconds = req.body.balanceSeconds;
  const reason = text(req.body.reason, 500) || null;

  if (status !== undefined && !VALID_USER_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid account status.' });
  }

  let normalizedBalance = null;
  if (balanceSeconds !== undefined) {
    normalizedBalance = integer(balanceSeconds, { min: 0 });
    if (normalizedBalance === null) {
      return res.status(400).json({ error: 'Balance must be a non-negative whole number of seconds.' });
    }
  }

  let suspendedUntil;
  if (status === 'suspended') {
    const requestedMinutes = integer(req.body.suspendMinutes, { min: 1, max: 5256000 });
    const fallbackDays = integer(req.body.suspendDays, { min: 1, max: 3650 });
    const durationMinutes = requestedMinutes ?? (fallbackDays ? fallbackDays * 1440 : 1440);
    suspendedUntil = new Date(Date.now() + durationMinutes * 60_000);
  } else if (status === 'active' || status === 'blocked') {
    suspendedUntil = null;
  }

  const result = await db.query(`
    UPDATE users
    SET
      status = CASE WHEN $2::text IS NULL THEN status ELSE $2 END,
      balance_seconds = CASE WHEN $3::int IS NULL THEN balance_seconds ELSE $3 END,
      suspended_until = CASE
        WHEN $2::text IS NULL THEN suspended_until
        WHEN $2 = 'suspended' THEN $4
        ELSE NULL
      END,
      suspension_reason = CASE
        WHEN $2::text IS NULL THEN suspension_reason
        WHEN $2 IN ('blocked', 'suspended') THEN $5
        ELSE NULL
      END,
      updated_at = now()
    WHERE id = $1
    RETURNING id, role, name, username, email, phone, balance_seconds, status,
              suspended_until, suspension_reason, updated_at
  `, [req.params.id, status ?? null, normalizedBalance, suspendedUntil ?? null, reason]);

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (status === 'blocked' || status === 'suspended') {
    await req.app.locals.socketRuntime?.restrictUser(req.params.id, reason || `Account ${status}`);
  }

  res.json({ user: result.rows[0] });
}));

router.post('/users/:id/adjust-minutes', asyncHandler(async (req, res) => {
  const secondsDelta = integer(req.body.secondsDelta);
  const note = text(req.body.note, 250) || 'Admin balance adjustment';

  if (secondsDelta === null || secondsDelta === 0) {
    return res.status(400).json({ error: 'Enter a non-zero whole number of seconds.' });
  }

  const output = await db.transaction(async (client) => {
    const userResult = await client.query(`
      UPDATE users
      SET balance_seconds = GREATEST(0, balance_seconds + $2), updated_at = now()
      WHERE id = $1 AND role = 'customer'
      RETURNING balance_seconds
    `, [req.params.id, secondsDelta]);

    if (!userResult.rows[0]) {
      throw Object.assign(new Error('Customer not found.'), { status: 404 });
    }

    await client.query(`
      INSERT INTO wallet_transactions (customer_id, seconds_delta, type, note)
      VALUES ($1, $2, 'admin_adjustment', $3)
    `, [req.params.id, secondsDelta, note]);

    return userResult.rows[0];
  });

  res.json({ balanceSeconds: output.balance_seconds });
}));

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const password = String(req.body.newPassword || '');
  if (password.length < 8) {
    return res.status(400).json({ error: 'The password must contain at least 8 characters.' });
  }

  const result = await db.query(`
    UPDATE users SET password_hash = $2, auth_version=auth_version+1, updated_at = now()
    WHERE id = $1
    RETURNING id
  `, [req.params.id, await hashPassword(password)]);

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  await db.query(`
    UPDATE password_reset_requests
    SET status = 'completed', resolved_at = now()
    WHERE user_id = $1 AND status IN ('open','approved')
  `, [req.params.id]);

  await req.app.locals.socketRuntime?.restrictUser(req.params.id, 'Password reset by administrator. Sign in again.');

  res.json({ ok: true });
}));

router.get('/users/:id/details', asyncHandler(async (req, res) => {
  const [user, calls, wallet, reports, support] = await Promise.all([
    db.query(`
      SELECT id, role, name, username, email, phone, bio,
             employee_code, upi_id, balance_seconds, status, suspended_until,
             suspension_reason, created_at
      FROM users WHERE id = $1
    `, [req.params.id]),
    db.query(`
      SELECT c.*, customer.name AS customer_name, employee.name AS employee_name
      FROM calls c
      JOIN users customer ON customer.id = c.customer_id
      JOIN users employee ON employee.id = c.employee_id
      WHERE c.customer_id = $1 OR c.employee_id = $1
      ORDER BY c.created_at DESC
      LIMIT 100
    `, [req.params.id]),
    db.query(`
      SELECT * FROM wallet_transactions
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.params.id]),
    db.query(`
      SELECT r.*, reporter.name AS reporter_name, target.name AS target_name
      FROM reports r
      JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN users target ON target.id = r.target_id
      WHERE r.reporter_id = $1 OR r.target_id = $1
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [req.params.id]),
    db.query(`
      SELECT * FROM support_tickets
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.params.id]),
  ]);

  if (!user.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  res.json({
    user: user.rows[0],
    calls: calls.rows,
    wallet: wallet.rows,
    reports: reports.rows,
    support: support.rows,
  });
}));

router.get('/plans', asyncHandler(async (_req, res) => {
  const result = await db.query('SELECT * FROM plans ORDER BY sort_order, price_paise');
  res.json({ plans: result.rows });
}));

router.post('/plans', asyncHandler(async (req, res) => {
  const name = text(req.body.name, 80);
  const pricePaise = integer(req.body.pricePaise, { min: 100, max: 100_000_000 });
  const seconds = integer(req.body.seconds, { min: 1, max: 31_536_000 });
  const sortOrder = integer(req.body.sortOrder, { min: -10_000, max: 10_000 }) ?? 0;
  const popular = Boolean(req.body.popular);

  if (!name || pricePaise === null || seconds === null) {
    return res.status(400).json({ error: 'Enter a valid plan name, price, and duration.' });
  }

  try {
    const result = await db.query(`
      INSERT INTO plans (name, price_paise, seconds, popular, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, pricePaise, seconds, popular, sortOrder]);

    res.status(201).json({ plan: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A plan with that name already exists.' });
    }
    throw error;
  }
}));

router.patch('/plans/:id', asyncHandler(async (req, res) => {
  const body = req.body;
  const name = body.name === undefined ? null : text(body.name, 80);
  const pricePaise = body.pricePaise === undefined ? null : integer(body.pricePaise, { min: 100, max: 100_000_000 });
  const seconds = body.seconds === undefined ? null : integer(body.seconds, { min: 1, max: 31_536_000 });
  const sortOrder = body.sortOrder === undefined ? null : integer(body.sortOrder, { min: -10_000, max: 10_000 });

  if (body.name !== undefined && !name) return res.status(400).json({ error: 'Plan name is required.' });
  if (body.pricePaise !== undefined && pricePaise === null) return res.status(400).json({ error: 'Invalid plan price.' });
  if (body.seconds !== undefined && seconds === null) return res.status(400).json({ error: 'Invalid plan duration.' });
  if (body.sortOrder !== undefined && sortOrder === null) return res.status(400).json({ error: 'Invalid display order.' });

  const result = await db.query(`
    UPDATE plans
    SET
      name = COALESCE($2, name),
      price_paise = COALESCE($3, price_paise),
      seconds = COALESCE($4, seconds),
      popular = COALESCE($5, popular),
      active = COALESCE($6, active),
      sort_order = COALESCE($7, sort_order),
      updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [
    req.params.id,
    name,
    pricePaise,
    seconds,
    body.popular === undefined ? null : Boolean(body.popular),
    body.active === undefined ? null : Boolean(body.active),
    sortOrder,
  ]);

  if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
  res.json({ plan: result.rows[0] });
}));

router.get('/coupons', asyncHandler(async (_req, res) => {
  const result = await db.query('SELECT * FROM coupons ORDER BY created_at DESC LIMIT 1000');
  res.json({ coupons: result.rows });
}));

router.post('/coupons', asyncHandler(async (req, res) => {
  const code = (text(req.body.code, 80) || crypto.randomBytes(4).toString('hex'))
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  const label = text(req.body.label, 120) || null;
  const seconds = integer(req.body.seconds, { min: 1, max: 31_536_000 });
  const maxUses = req.body.maxUses === '' || req.body.maxUses === null || req.body.maxUses === undefined
    ? null
    : integer(req.body.maxUses, { min: 1, max: 10_000_000 });
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;

  if (code.length < 4 || seconds === null || (req.body.maxUses && maxUses === null)) {
    return res.status(400).json({ error: 'Enter a valid code, duration, and usage limit.' });
  }
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return res.status(400).json({ error: 'Invalid coupon expiry date.' });
  }

  try {
    const result = await db.query(`
      INSERT INTO coupons (code, label, seconds, max_uses, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [code, label, seconds, maxUses, expiresAt, req.user.id]);

    res.status(201).json({ coupon: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'That coupon code already exists.' });
    }
    throw error;
  }
}));

router.patch('/coupons/:id', asyncHandler(async (req, res) => {
  const result = await db.query(`
    UPDATE coupons SET active = $2
    WHERE id = $1
    RETURNING *
  `, [req.params.id, Boolean(req.body.active)]);

  if (!result.rows[0]) return res.status(404).json({ error: 'Coupon not found.' });
  res.json({ coupon: result.rows[0] });
}));

router.get('/calls', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT c.*, customer.name AS customer_name, customer.email AS customer_email,
           employee.name AS employee_name, employee.email AS employee_email
    FROM calls c
    JOIN users customer ON customer.id = c.customer_id
    JOIN users employee ON employee.id = c.employee_id
    ORDER BY c.created_at DESC
    LIMIT 1000
  `);
  res.json({ calls: result.rows });
}));

router.get('/reports', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT r.*, reporter.name AS reporter_name, reporter.role AS reporter_role,
           target.name AS target_name
    FROM reports r
    JOIN users reporter ON reporter.id = r.reporter_id
    LEFT JOIN users target ON target.id = r.target_id
    ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
             r.created_at DESC
  `);
  res.json({ reports: result.rows });
}));

router.patch('/reports/:id', asyncHandler(async (req, res) => {
  const status = String(req.body.status || '');
  if (!VALID_REPORT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid report status.' });
  }

  const result = await db.query(`
    UPDATE reports
    SET status = $2, admin_note = $3, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [req.params.id, status, text(req.body.adminNote, 2000) || null]);

  if (!result.rows[0]) return res.status(404).json({ error: 'Report not found.' });
  res.json({ report: result.rows[0] });
}));

router.get('/support', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT ticket.*, customer.name AS customer_name, customer.email AS customer_email
    FROM support_tickets ticket
    JOIN users customer ON customer.id = ticket.customer_id
    ORDER BY CASE ticket.status WHEN 'open' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END,
             ticket.created_at DESC
  `);
  res.json({ tickets: result.rows });
}));

router.patch('/support/:id', asyncHandler(async (req, res) => {
  const reply = text(req.body.adminReply, 3000);
  const status = String(req.body.status || 'replied');

  if (!VALID_SUPPORT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid support-ticket status.' });
  }

  const result = await db.query(`
    UPDATE support_tickets
    SET admin_reply = $2, status = $3, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [req.params.id, reply || null, status]);

  const ticket = result.rows[0];
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found.' });

  const title = 'Support reply';
  const body = reply || 'Your support request has been updated.';
  await db.query(`
    INSERT INTO notifications (user_id, title, body)
    VALUES ($1, $2, $3)
  `, [ticket.customer_id, title, body]);
  await req.app.locals.notifyUser?.(ticket.customer_id, { title, body, url: './', tag: `we-met-support-${ticket.id}` });

  res.json({ ticket });
}));

router.get('/password-resets', asyncHandler(async (_req, res) => {
  await db.query(`
    UPDATE password_reset_requests
    SET status='declined',admin_message='This recovery request expired.',resolved_at=now()
    WHERE status IN ('open','approved') AND expires_at<=now()
  `);
  const result = await db.query(`
    SELECT request.*, user_account.name, user_account.email, user_account.username,
           user_account.role
    FROM password_reset_requests request
    JOIN users user_account ON user_account.id = request.user_id
    ORDER BY CASE request.status WHEN 'open' THEN 0 ELSE 1 END,
             request.created_at DESC
  `);
  res.json({ requests: result.rows });
}));

router.patch('/password-resets/:id', asyncHandler(async (req, res) => {
  const action = String(req.body.action || '');
  if (!['approved', 'declined'].includes(action)) {
    return res.status(400).json({ error: 'Choose approve or decline.' });
  }
  const adminMessage = text(req.body.adminMessage, 1000) || null;
  const result = await db.query(`
    UPDATE password_reset_requests
    SET status=$2,admin_message=$3,reviewed_by=$4,reviewed_at=now(),
        resolved_at=CASE WHEN $2='declined' THEN now() ELSE NULL END
    WHERE id=$1 AND status='open' AND expires_at>now()
    RETURNING *
  `, [req.params.id, action, adminMessage, req.user.id]);
  const request = result.rows[0];
  if (!request) return res.status(409).json({ error: 'This request is no longer open or has expired.' });
  const title = action === 'approved' ? 'Password recovery approved' : 'Password recovery declined';
  const body = action === 'approved'
    ? `Your recovery request was approved. Return to the recovery screen and use your saved key.${adminMessage ? ` ${adminMessage}` : ''}`
    : `Your recovery request was declined.${adminMessage ? ` ${adminMessage}` : ' Contact support if you still need help.'}`;
  await db.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [request.user_id, title, body]);
  await req.app.locals.notifyUser?.(request.user_id, { title, body, url: './', tag: `we-met-recovery-${request.id}` });
  res.json({ request });
}));

router.get('/payments', asyncHandler(async (_req, res) => {
  const [manual, razorpay] = await Promise.all([
    db.query(`
      SELECT payment.id,payment.customer_id,payment.plan_id,payment.plan_name,
             payment.amount_paise,payment.seconds,payment.payee_upi_id,
             payment.payment_method,payment.checkout_reference,payment.destination_last4,
             payment.utr_reference,payment.customer_note,payment.proof_size,payment.status,
             payment.admin_message,payment.reviewed_at,payment.created_at,
             customer.name AS customer_name,customer.email AS customer_email,
             customer.phone AS customer_phone
      FROM payment_submissions payment
      JOIN users customer ON customer.id=payment.customer_id
      ORDER BY CASE payment.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               payment.created_at DESC
      LIMIT 1000
    `),
    db.query(`
      SELECT payment.id,payment.customer_id,payment.plan_id,payment.plan_name,
             payment.amount_paise,payment.seconds,payment.currency,
             payment.razorpay_order_id,payment.razorpay_payment_id,
             payment.payment_method,payment.status,payment.failure_description,
             payment.captured_at,payment.credited_at,payment.created_at,
             customer.name AS customer_name,customer.email AS customer_email,
             customer.phone AS customer_phone
      FROM razorpay_orders payment
      JOIN users customer ON customer.id=payment.customer_id
      ORDER BY payment.created_at DESC
      LIMIT 1000
    `),
  ]);
  res.json({ payments: manual.rows, razorpayOrders: razorpay.rows });
}));

router.get('/payments/:id/proof', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT proof_mime,proof_data FROM payment_submissions WHERE id=$1', [req.params.id]);
  const proof = result.rows[0];
  if (!proof?.proof_data || !proof?.proof_mime) {
    return res.status(404).json({ error: 'No payment screenshot was attached.' });
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(proof.proof_mime)) {
    return res.status(415).json({ error: 'This older attachment is not a supported safe image format.' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(proof.proof_mime).send(proof.proof_data);
}));

router.patch('/payments/:id', asyncHandler(async (req, res) => {
  const action = String(req.body.action || '');
  if (!['approved', 'declined'].includes(action)) {
    return res.status(400).json({ error: 'Choose approve or decline.' });
  }
  const adminMessage = text(req.body.adminMessage, 1000) || null;

  const payment = await db.transaction(async (client) => {
    const found = await client.query(`
      SELECT * FROM payment_submissions WHERE id=$1 FOR UPDATE
    `, [req.params.id]);
    const record = found.rows[0];
    if (!record) throw Object.assign(new Error('Payment submission not found.'), { status: 404 });
    if (record.status !== 'pending') throw Object.assign(new Error('This payment has already been reviewed.'), { status: 409 });
    if (action === 'approved' && record.manual_intent_id && !record.utr_reference) {
      throw Object.assign(new Error('This payment has no UTR and cannot be approved.'), { status: 400 });
    }
    if (action === 'approved' && record.manual_intent_id && (!record.proof_data || !record.proof_mime)) {
      throw Object.assign(new Error('This payment has no screenshot and cannot be approved.'), { status: 400 });
    }
    if (action === 'approved' && record.utr_reference) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [record.utr_reference]);
      const duplicate = await client.query(`
        SELECT id FROM payment_submissions
        WHERE id<>$1
          AND lower(regexp_replace(utr_reference, '\\s+', '', 'g'))=lower(regexp_replace($2, '\\s+', '', 'g'))
          AND status='approved'
        LIMIT 1
        FOR UPDATE
      `, [record.id, record.utr_reference]);
      if (duplicate.rows[0]) {
        throw Object.assign(new Error('This transfer reference was already approved for another submission.'), { status: 409 });
      }
    }

    const updated = await client.query(`
      UPDATE payment_submissions
      SET status=$2,admin_message=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now()
      WHERE id=$1
      RETURNING id,customer_id,plan_id,plan_name,amount_paise,seconds,payee_upi_id,
                utr_reference,customer_note,status,admin_message,reviewed_at,created_at,updated_at
    `, [record.id, action, adminMessage, req.user.id]);

    if (action === 'approved') {
      await client.query(`
        UPDATE users
        SET balance_seconds=balance_seconds+$2,updated_at=now()
        WHERE id=$1 AND role='customer'
      `, [record.customer_id, record.seconds]);
      await client.query(`
        INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
        VALUES($1,$2,'payment',$3,$4)
      `, [
        record.customer_id,
        record.seconds,
        `${record.plan_name} · administrator-approved ${record.payment_method === 'bank_transfer' ? 'older bank transfer' : 'direct UPI payment'}`,
        record.id,
      ]);
    }

    const title = action === 'approved' ? 'Payment approved' : 'Payment declined';
    const body = action === 'approved'
      ? `${Math.round(record.seconds / 60)} minutes were added to your wallet.${adminMessage ? ` ${adminMessage}` : ''}`
      : `Your ${record.plan_name} payment proof was declined.${adminMessage ? ` ${adminMessage}` : ''}`;
    await client.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [record.customer_id, title, body]);
    return { ...updated.rows[0], notification: { title, body } };
  });

  await req.app.locals.notifyUser?.(payment.customer_id, {
    ...payment.notification,
    url: './',
    tag: `we-met-payment-${payment.id}`,
  });
  res.json({ payment });
}));

router.post('/notifications', asyncHandler(async (req, res) => {
  const userId = req.body.userId || null;
  const title = text(req.body.title, 120) || 'We Met';
  const body = text(req.body.body, 1000);

  if (!body) return res.status(400).json({ error: 'Notification message is required.' });

  let userIds;
  if (userId) {
    userIds = [userId];
  } else {
    const result = await db.query(`
      SELECT id FROM users
      WHERE role IN ('customer', 'employee') AND status = 'active'
    `);
    userIds = result.rows.map((row) => row.id);
  }

  for (const id of userIds) {
    await db.query(`
      INSERT INTO notifications (user_id, title, body)
      VALUES ($1, $2, $3)
    `, [id, title, body]);
    await req.app.locals.notifyUser?.(id, { title, body, url: './', tag: `we-met-admin-${Date.now()}` });
  }

  res.json({ sent: userIds.length });
}));

router.get('/demo-listeners', asyncHandler(async (_req, res) => {
  const result = await db.query(`SELECT id,name,bio,avatar,activity,randomize,enabled,created_at,updated_at FROM demo_listeners ORDER BY created_at DESC`);
  res.json({ listeners: result.rows });
}));

router.post('/demo-listeners', asyncHandler(async (req, res) => {
  const name = text(req.body.name, 100);
  const bio = text(req.body.bio, 500) || null;
  const avatar = text(req.body.avatar, 300) || null;
  const activity = ['available','break','busy','offline'].includes(req.body.activity) ? req.body.activity : 'available';
  const randomize = Boolean(req.body.randomize);
  if (name.length < 2) return res.status(400).json({ error: 'Enter a display name.' });
  const result = await db.query(`INSERT INTO demo_listeners(name,bio,avatar,activity,randomize) VALUES($1,$2,$3,$4,$5) RETURNING *`, [name,bio,avatar,activity,randomize]);
  res.status(201).json({ listener: result.rows[0] });
}));

router.patch('/demo-listeners/:id', asyncHandler(async (req, res) => {
  const name = text(req.body.name, 100);
  const bio = text(req.body.bio, 500) || null;
  const avatar = text(req.body.avatar, 300) || null;
  const activity = ['available','break','busy','offline'].includes(req.body.activity) ? req.body.activity : 'offline';
  const randomize = Boolean(req.body.randomize);
  const enabled = req.body.enabled !== false;
  if (name.length < 2) return res.status(400).json({ error: 'Enter a display name.' });
  const result = await db.query(`UPDATE demo_listeners SET name=$2,bio=$3,avatar=$4,activity=$5,randomize=$6,enabled=$7,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id,name,bio,avatar,activity,randomize,enabled]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Demo listener not found.' });
  req.app.locals.socketRuntime?.refreshDemoListeners?.();
  res.json({ listener: result.rows[0] });
}));

router.delete('/demo-listeners/:id', asyncHandler(async (req, res) => {
  const result = await db.query('DELETE FROM demo_listeners WHERE id=$1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Demo listener not found.' });
  req.app.locals.socketRuntime?.refreshDemoListeners?.();
  res.json({ ok: true });
}));

module.exports = router;
