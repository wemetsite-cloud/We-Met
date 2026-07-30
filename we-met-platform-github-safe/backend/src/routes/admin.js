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
  const [users, calls, reports, tickets, coupons, minutes] = await Promise.all([
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
  ]);

  res.json({
    users: users.rows,
    calls: calls.rows,
    openReports: reports.rows[0].count,
    openTickets: tickets.rows[0].count,
    activeCoupons: coupons.rows[0].count,
    totalTalkSeconds: Number(minutes.rows[0].seconds),
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
    SELECT id, role, name, username, email, phone, date_of_birth, bio,
           employee_code, upi_id, balance_seconds, status, suspended_until,
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
                employee_code, status, created_at
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
    UPDATE users SET password_hash = $2, updated_at = now()
    WHERE id = $1
    RETURNING id
  `, [req.params.id, await hashPassword(password)]);

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  await db.query(`
    UPDATE password_reset_requests
    SET status = 'resolved', resolved_at = now()
    WHERE user_id = $1 AND status = 'open'
  `, [req.params.id]);

  res.json({ ok: true });
}));

router.get('/users/:id/details', asyncHandler(async (req, res) => {
  const [user, calls, wallet, reports, support] = await Promise.all([
    db.query(`
      SELECT id, role, name, username, email, phone, date_of_birth, bio,
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
  const pricePaise = integer(req.body.pricePaise, { min: 1, max: 100_000_000 });
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
  const pricePaise = body.pricePaise === undefined ? null : integer(body.pricePaise, { min: 1, max: 100_000_000 });
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
  req.app.locals.socketRuntime?.notifyUser(ticket.customer_id, { title, body });

  res.json({ ticket });
}));

router.get('/password-resets', asyncHandler(async (_req, res) => {
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
    req.app.locals.socketRuntime?.notifyUser(id, { title, body });
  }

  res.json({ sent: userIds.length });
}));

module.exports = router;
