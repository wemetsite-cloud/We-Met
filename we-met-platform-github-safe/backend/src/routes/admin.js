const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hashPassword } = require('../auth');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const { normalizeProfileImage } = require('../profile-image');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

router.use((req, res, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const originalPath = String(req.originalUrl || '').split('?')[0];
  const requestIp = req.ip;
  const userAgent = text(req.headers['user-agent'], 500) || null;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const uuidMatch = originalPath.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
    const targetType = originalPath.split('/').filter(Boolean).at(2) || null;
    db.query(`
      INSERT INTO admin_audit_log(admin_id,action,target_type,target_id,route,ip_address,user_agent,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    `, [
      req.user.id,
      `${req.method} ${originalPath}`,
      targetType,
      uuidMatch?.[0] || null,
      originalPath,
      requestIp,
      userAgent,
      JSON.stringify({ statusCode: res.statusCode }),
    ]).catch((error) => console.error('Admin audit log failed:', error));
  });
  return next();
});

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

function upiId(value) {
  const normalized = text(value, 120).toLowerCase();
  if (!normalized) return null;
  return /^[a-z0-9._-]{2,100}@[a-z0-9.-]{2,40}$/.test(normalized) ? normalized : false;
}

function upiPhone(value) {
  const original = text(value, 40);
  if (!original) return null;
  const digits = original.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return false;
}

router.get('/dashboard', asyncHandler(async (_req, res) => {
  const [users, calls, reports, tickets, coupons, minutes, withdrawals] = await Promise.all([
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
    db.query(`
      SELECT COUNT(*)::int AS count,COALESCE(SUM(amount_paise),0)::bigint AS amount_paise
      FROM listener_withdrawal_requests WHERE status='pending'
    `),
  ]);

  res.json({
    users: users.rows,
    calls: calls.rows,
    openReports: reports.rows[0].count,
    openTickets: tickets.rows[0].count,
    activeCoupons: coupons.rows[0].count,
    totalTalkSeconds: Number(minutes.rows[0].seconds),
    pendingWithdrawals: withdrawals.rows[0].count,
    pendingWithdrawalPaise: Number(withdrawals.rows[0].amount_paise || 0),
  });
}));

router.get('/users', asyncHandler(async (req, res) => {
  const role = String(req.query.role || '');
  const params = [];
  let where = '';

  if (['customer', 'employee', 'admin'].includes(role)) {
    params.push(role);
    where = 'WHERE u.role = $1';
  }

  const result = await db.query(`
    SELECT u.id, u.role, u.name, u.username, u.email, u.phone, u.bio, CASE WHEN u.profile_image LIKE 'data:image/%' THEN 'photo:'||u.id::text ELSE u.profile_image END AS profile_image,
           u.employee_code, u.upi_id, u.upi_phone, u.listener_rate_paise,
           u.listener_availability, u.listener_language,
           u.balance_seconds, u.status, u.suspended_until, u.suspension_reason,
           u.last_login_at, u.last_seen_at, u.created_at,
           COALESCE(call_stats.total_calls,0)::int AS total_calls,
           COALESCE(call_stats.connected_calls,0)::int AS connected_calls,
           COALESCE(call_stats.today_calls,0)::int AS today_calls,
           COALESCE(call_stats.total_talk_seconds,0)::bigint AS total_talk_seconds,
           COALESCE(call_stats.today_talk_seconds,0)::bigint AS today_talk_seconds,
           COALESCE(activity_stats.total_work_seconds,0)::bigint AS total_work_seconds,
           COALESCE(activity_stats.today_work_seconds,0)::bigint AS today_work_seconds,
           COALESCE(activity_stats.today_break_seconds,0)::bigint AS today_break_seconds,
           COALESCE(listener_wallet.balance_paise,0)::bigint AS listener_wallet_balance_paise,
           COALESCE(listener_wallet.lifetime_earnings_paise,0)::bigint AS listener_lifetime_earnings_paise,
           COALESCE(listener_wallet.lifetime_paid_paise,0)::bigint AS listener_lifetime_paid_paise,
           activity_stats.current_activity_started_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total_calls,
             COUNT(*) FILTER (WHERE c.started_at IS NOT NULL)::int AS connected_calls,
             COUNT(*) FILTER (WHERE c.created_at>=date_trunc('day',now()))::int AS today_calls,
             COALESCE(SUM(c.billed_seconds),0)::bigint AS total_talk_seconds,
             COALESCE(SUM(c.billed_seconds) FILTER (WHERE c.created_at>=date_trunc('day',now())),0)::bigint AS today_talk_seconds
      FROM calls c
      WHERE c.employee_id=u.id
    ) call_stats ON u.role='employee'
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(CASE WHEN s.state='online' THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(s.ended_at,now())-s.started_at))) ELSE 0 END),0)::bigint AS total_work_seconds,
        COALESCE(SUM(CASE WHEN s.state='online' AND COALESCE(s.ended_at,now())>date_trunc('day',now()) THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(s.ended_at,now())-GREATEST(s.started_at,date_trunc('day',now()))))) ELSE 0 END),0)::bigint AS today_work_seconds,
        COALESCE(SUM(CASE WHEN s.state='break' AND COALESCE(s.ended_at,now())>date_trunc('day',now()) THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(s.ended_at,now())-GREATEST(s.started_at,date_trunc('day',now()))))) ELSE 0 END),0)::bigint AS today_break_seconds,
        MAX(s.started_at) FILTER (WHERE s.ended_at IS NULL) AS current_activity_started_at
      FROM listener_activity_sessions s
      WHERE s.employee_id=u.id
    ) activity_stats ON u.role='employee'
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount_paise),0)::bigint AS balance_paise,
             COALESCE(SUM(t.amount_paise) FILTER (WHERE t.type='call_credit'),0)::bigint AS lifetime_earnings_paise,
             COALESCE(SUM(-t.amount_paise) FILTER (WHERE t.type='payout'),0)::bigint AS lifetime_paid_paise
      FROM listener_wallet_transactions t
      WHERE t.employee_id=u.id
    ) listener_wallet ON u.role='employee'
    ${where}
    ORDER BY u.created_at DESC
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
  const listenerUpiId = upiId(req.body.upiId);
  const listenerUpiPhone = upiPhone(req.body.upiPhone);
  const bio = text(req.body.bio, 500) || null;
  const language = text(req.body.language, 60) || 'Malayalam';
  const ratePaise = integer(req.body.ratePaise, { min: 0, max: 10_000_000 });
  const employeeCode = (text(req.body.employeeCode, 40) || `WM-L${Date.now().toString().slice(-6)}`)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');

  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return res.status(400).json({
      error: 'Enter a valid name, email address, and a password with at least 8 characters.',
    });
  }
  if (listenerUpiId === false) return res.status(400).json({ error: 'Enter a valid listener UPI ID.' });
  if (listenerUpiPhone === false) return res.status(400).json({ error: 'Enter a valid UPI-linked mobile number.' });
  if (ratePaise === null) return res.status(400).json({ error: 'Set a valid listener rate per minute.' });

  if (username && !/^[a-z0-9._-]{3,80}$/.test(username)) {
    return res.status(400).json({
      error: 'Username may contain only letters, numbers, dots, underscores, and hyphens.',
    });
  }

  try {
    const result = await db.query(`
      INSERT INTO users (
        role, name, username, email, phone, upi_id, upi_phone, bio, employee_code,
        listener_language, listener_rate_paise, password_hash
      )
      VALUES ('employee', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, role, name, username, email, phone, upi_id, upi_phone, bio,
                employee_code, listener_availability, listener_language,
                listener_rate_paise, status, created_at
    `, [
      name,
      username,
      email,
      phone,
      listenerUpiId,
      listenerUpiPhone,
      bio,
      employeeCode,
      language,
      ratePaise,
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

router.patch('/employees/:id', asyncHandler(async (req, res) => {
  const name = text(req.body.name, 100);
  const username = text(req.body.username, 80).toLowerCase() || null;
  const email = text(req.body.email, 180).toLowerCase();
  const phone = text(req.body.phone, 30) || null;
  const listenerUpiId = upiId(req.body.upiId);
  const hasUpiPhone = Object.hasOwn(req.body, 'upiPhone');
  const listenerUpiPhone = hasUpiPhone ? upiPhone(req.body.upiPhone) : null;
  const bio = text(req.body.bio, 500) || null;
  const profileImage = normalizeProfileImage(req.body.profileImage);
  const language = text(req.body.language, 60) || 'Malayalam';
  const hasRate = Object.hasOwn(req.body, 'ratePaise');
  const ratePaise = hasRate ? integer(req.body.ratePaise, { min: 0, max: 10_000_000 }) : null;

  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid name and email address.' });
  }
  if (username && !/^[a-z0-9._-]{3,80}$/.test(username)) {
    return res.status(400).json({ error: 'Username may contain only letters, numbers, dots, underscores, and hyphens.' });
  }
  if (listenerUpiId === false) return res.status(400).json({ error: 'Enter a valid listener UPI ID.' });
  if (listenerUpiPhone === false) return res.status(400).json({ error: 'Enter a valid UPI-linked mobile number.' });
  if (profileImage === false) return res.status(400).json({ error: 'Choose a built-in avatar or upload a valid JPG, PNG, or WebP profile photo.' });
  if (hasRate && ratePaise === null) return res.status(400).json({ error: 'Set a valid listener rate per minute.' });

  try {
    const result = await db.query(`
      UPDATE users
      SET name=$2,username=$3,email=$4,phone=$5,upi_id=$6,
          upi_phone=CASE WHEN $9::boolean THEN $7 ELSE upi_phone END,
          bio=$8,listener_language=$10,
          listener_rate_paise=CASE WHEN $11::boolean THEN $12 ELSE listener_rate_paise END,
          profile_image=CASE WHEN $13::boolean THEN $14 ELSE profile_image END,
          updated_at=now()
      WHERE id=$1 AND role='employee'
      RETURNING id,role,name,username,email,phone,upi_id,upi_phone,bio,profile_image,employee_code,
                listener_availability,listener_language,listener_rate_paise,status,created_at
    `, [
      req.params.id,
      name,
      username,
      email,
      phone,
      listenerUpiId,
      listenerUpiPhone,
      bio,
      hasUpiPhone,
      language,
      hasRate,
      ratePaise,
      profileImage !== undefined,
      profileImage === undefined ? null : profileImage,
    ]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Listener not found.' });
    await req.app.locals.socketRuntime?.refreshEmployeeProfile?.(req.params.id);
    const employee = result.rows[0];
    if (String(employee.profile_image || '').startsWith('data:image/')) employee.profile_image = `photo:${employee.id}`;
    res.json({ employee });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email address or username is already in use.' });
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
    WHERE id = $1 AND role <> 'admin'
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
    WHERE id = $1 AND role <> 'admin'
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
  const [
    user,
    calls,
    wallet,
    listenerWallet,
    listenerWalletSummary,
    listenerWithdrawals,
    reports,
    support,
    callAnalytics,
    workAnalytics,
    activitySessions,
    audits,
  ] = await Promise.all([
    db.query(`
      SELECT id, role, name, username, email, phone, bio, CASE WHEN profile_image LIKE 'data:image/%' THEN 'photo:'||id::text ELSE profile_image END AS profile_image,
             employee_code, upi_id, upi_phone, listener_rate_paise,
             listener_availability, listener_language,
             balance_seconds, status, suspended_until, suspension_reason,
             last_login_at, last_seen_at, created_at, updated_at
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
      SELECT t.*,c.started_at AS call_started_at,c.ended_at AS call_ended_at
      FROM listener_wallet_transactions t
      LEFT JOIN calls c ON c.id=t.reference_id AND t.type='call_credit'
      WHERE t.employee_id=$1
      ORDER BY t.created_at DESC
      LIMIT 250
    `, [req.params.id]),
    db.query(`
      SELECT COALESCE(SUM(amount_paise),0)::bigint AS balance_paise,
             COALESCE(SUM(amount_paise) FILTER (WHERE type='call_credit'),0)::bigint AS lifetime_earnings_paise,
             COALESCE(SUM(-amount_paise) FILTER (WHERE type='payout'),0)::bigint AS lifetime_paid_paise,
             COALESCE(SUM(amount_paise) FILTER (
               WHERE type='call_credit' AND created_at>=date_trunc('day',now())
             ),0)::bigint AS today_earnings_paise,
             COALESCE(SUM(amount_paise) FILTER (
               WHERE type='call_credit' AND created_at>=now()-interval '7 days'
             ),0)::bigint AS week_earnings_paise
      FROM listener_wallet_transactions
      WHERE employee_id=$1
    `, [req.params.id]),
    db.query(`
      SELECT id,amount_paise,payout_upi_id,payout_upi_phone,listener_note,status,
             payment_reference,admin_note,requested_at,reviewed_at,paid_at
      FROM listener_withdrawal_requests
      WHERE employee_id=$1
      ORDER BY requested_at DESC
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
    db.query(`
      SELECT COUNT(*)::int AS total_calls,
             COUNT(*) FILTER (WHERE started_at IS NOT NULL)::int AS connected_calls,
             COUNT(*) FILTER (WHERE created_at>=date_trunc('day',now()))::int AS today_calls,
             COUNT(*) FILTER (WHERE created_at>=now()-interval '7 days')::int AS week_calls,
             COUNT(*) FILTER (WHERE status IN ('rejected','cancelled','failed'))::int AS missed_calls,
             COALESCE(SUM(billed_seconds),0)::bigint AS total_talk_seconds,
             COALESCE(SUM(billed_seconds) FILTER (WHERE created_at>=date_trunc('day',now())),0)::bigint AS today_talk_seconds,
             COALESCE(SUM(billed_seconds) FILTER (WHERE created_at>=now()-interval '7 days'),0)::bigint AS week_talk_seconds,
             COALESCE(AVG(NULLIF(billed_seconds,0)),0)::int AS average_talk_seconds
      FROM calls
      WHERE employee_id=$1
    `, [req.params.id]),
    db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN state='online' THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-started_at))) ELSE 0 END),0)::bigint AS total_work_seconds,
        COALESCE(SUM(CASE WHEN state='online' AND COALESCE(ended_at,now())>date_trunc('day',now()) THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-GREATEST(started_at,date_trunc('day',now()))))) ELSE 0 END),0)::bigint AS today_work_seconds,
        COALESCE(SUM(CASE WHEN state='online' AND COALESCE(ended_at,now())>now()-interval '7 days' THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-GREATEST(started_at,now()-interval '7 days')))) ELSE 0 END),0)::bigint AS week_work_seconds,
        COALESCE(SUM(CASE WHEN state='break' THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-started_at))) ELSE 0 END),0)::bigint AS total_break_seconds,
        COALESCE(SUM(CASE WHEN state='break' AND COALESCE(ended_at,now())>date_trunc('day',now()) THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,now())-GREATEST(started_at,date_trunc('day',now()))))) ELSE 0 END),0)::bigint AS today_break_seconds
      FROM listener_activity_sessions
      WHERE employee_id=$1
    `, [req.params.id]),
    db.query(`
      SELECT id,state,started_at,ended_at,
             CASE WHEN ended_at IS NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (now()-started_at))::int) ELSE duration_seconds END AS duration_seconds,
             end_reason
      FROM listener_activity_sessions
      WHERE employee_id=$1
      ORDER BY started_at DESC
      LIMIT 100
    `, [req.params.id]),
    db.query(`
      SELECT log.*,admin.name AS admin_name
      FROM admin_audit_log log
      LEFT JOIN users admin ON admin.id=log.admin_id
      WHERE log.target_id=$1::text
      ORDER BY log.created_at DESC
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
    listenerWallet: listenerWallet.rows,
    listenerWalletSummary: listenerWalletSummary.rows[0],
    listenerWithdrawals: listenerWithdrawals.rows,
    reports: reports.rows,
    support: support.rows,
    callAnalytics: callAnalytics.rows[0],
    workAnalytics: workAnalytics.rows[0],
    activitySessions: activitySessions.rows,
    audits: audits.rows,
  });
}));

router.get('/listener-wallets', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT u.id,u.name,u.email,u.phone,CASE WHEN u.profile_image LIKE 'data:image/%' THEN 'photo:'||u.id::text ELSE u.profile_image END AS profile_image,u.employee_code,u.upi_id,u.upi_phone,
           u.listener_rate_paise,u.listener_language,u.listener_availability,u.status,
           COALESCE(wallet.balance_paise,0)::bigint AS balance_paise,
           COALESCE(wallet.lifetime_earnings_paise,0)::bigint AS lifetime_earnings_paise,
           COALESCE(wallet.lifetime_paid_paise,0)::bigint AS lifetime_paid_paise,
           COALESCE(wallet.today_earnings_paise,0)::bigint AS today_earnings_paise,
           COALESCE(wallet.week_earnings_paise,0)::bigint AS week_earnings_paise,
           wallet.last_paid_at,
           pending.id AS pending_withdrawal_id,
           pending.amount_paise::bigint AS pending_withdrawal_paise,
           pending.requested_at AS pending_withdrawal_requested_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount_paise),0)::bigint AS balance_paise,
             COALESCE(SUM(t.amount_paise) FILTER (WHERE t.type='call_credit'),0)::bigint AS lifetime_earnings_paise,
             COALESCE(SUM(-t.amount_paise) FILTER (WHERE t.type='payout'),0)::bigint AS lifetime_paid_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type='call_credit' AND t.created_at>=date_trunc('day',now())
             ),0)::bigint AS today_earnings_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type='call_credit' AND t.created_at>=now()-interval '7 days'
             ),0)::bigint AS week_earnings_paise,
             MAX(t.created_at) FILTER (WHERE t.type='payout') AS last_paid_at
      FROM listener_wallet_transactions t
      WHERE t.employee_id=u.id
    ) wallet ON true
    LEFT JOIN LATERAL (
      SELECT id,amount_paise,requested_at
      FROM listener_withdrawal_requests
      WHERE employee_id=u.id AND status='pending'
      LIMIT 1
    ) pending ON true
    WHERE u.role='employee'
    ORDER BY COALESCE(wallet.balance_paise,0) DESC,u.name
  `);

  res.json({
    wallets: result.rows.map((row) => ({
      ...row,
      listener_rate_paise: Number(row.listener_rate_paise || 0),
      balance_paise: Number(row.balance_paise || 0),
      lifetime_earnings_paise: Number(row.lifetime_earnings_paise || 0),
      lifetime_paid_paise: Number(row.lifetime_paid_paise || 0),
      today_earnings_paise: Number(row.today_earnings_paise || 0),
      week_earnings_paise: Number(row.week_earnings_paise || 0),
      pending_withdrawal_paise: Number(row.pending_withdrawal_paise || 0),
    })),
  });
}));

router.get('/withdrawals', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT request.id,request.employee_id,request.amount_paise,request.payout_upi_id,
           request.payout_upi_phone,request.listener_note,request.status,
           request.payment_reference,request.admin_note,request.requested_at,
           request.reviewed_at,request.paid_at,listener.name AS listener_name,
           listener.email AS listener_email,listener.employee_code,
           CASE WHEN listener.profile_image LIKE 'data:image/%' THEN 'photo:'||listener.id::text ELSE listener.profile_image END AS profile_image,
           reviewer.name AS reviewer_name
    FROM listener_withdrawal_requests request
    JOIN users listener ON listener.id=request.employee_id
    LEFT JOIN users reviewer ON reviewer.id=request.reviewed_by
    ORDER BY CASE request.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
             request.requested_at DESC
    LIMIT 1000
  `);
  res.json({
    requests: result.rows.map((request) => ({
      ...request,
      amount_paise: Number(request.amount_paise || 0),
    })),
    minimumWithdrawalPaise: 10_000,
  });
}));

router.patch('/listener-wallets/:id/rate', asyncHandler(async (req, res) => {
  const ratePaise = integer(req.body.ratePaise, { min: 0, max: 10_000_000 });
  if (ratePaise === null) return res.status(400).json({ error: 'Set a valid listener rate per minute.' });

  const result = await db.query(`
    UPDATE users
    SET listener_rate_paise=$2,updated_at=now()
    WHERE id=$1 AND role='employee'
    RETURNING id,name,listener_rate_paise
  `, [req.params.id, ratePaise]);
  const listener = result.rows[0];
  if (!listener) return res.status(404).json({ error: 'Listener not found.' });

  const title = 'Listener rate updated';
  const body = `Your rate is now ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(ratePaise / 100)} per connected minute. New calls use this rate.`;
  await db.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [listener.id, title, body]);
  await req.app.locals.notifyUser?.(listener.id, { title, body, url: './', tag: `we-met-listener-rate-${Date.now()}` });
  res.json({ listener: { ...listener, listener_rate_paise: Number(listener.listener_rate_paise) } });
}));

router.patch('/withdrawals/:id', asyncHandler(async (req, res) => {
  const action = text(req.body.action, 20).toLowerCase();
  const paymentReference = text(req.body.paymentReference, 160) || null;
  const adminNote = text(req.body.adminNote, 500) || null;
  if (!['paid', 'declined'].includes(action)) {
    return res.status(400).json({ error: 'Choose paid or declined.' });
  }
  if (action === 'paid' && (!paymentReference || paymentReference.length < 3)) {
    return res.status(400).json({ error: 'Enter the UPI transaction reference before confirming payment.' });
  }

  const output = await db.transaction(async (client) => {
    const preliminary = await client.query(`
      SELECT employee_id FROM listener_withdrawal_requests WHERE id=$1
    `, [req.params.id]);
    if (!preliminary.rows[0]) throw Object.assign(new Error('Withdrawal request not found.'), { status: 404 });
    const listener = await client.query(`
      SELECT id FROM users WHERE id=$1 AND role='employee' FOR UPDATE
    `, [preliminary.rows[0].employee_id]);
    if (!listener.rows[0]) throw Object.assign(new Error('Listener account not found.'), { status: 404 });
    const found = await client.query(`
      SELECT request.*,listener.name AS listener_name
      FROM listener_withdrawal_requests request
      JOIN users listener ON listener.id=request.employee_id
      WHERE request.id=$1
      FOR UPDATE OF request
    `, [req.params.id]);
    const request = found.rows[0];
    if (!request) throw Object.assign(new Error('Withdrawal request not found.'), { status: 404 });
    if (request.status !== 'pending') {
      throw Object.assign(new Error('This withdrawal request has already been reviewed.'), { status: 409 });
    }

    if (action === 'paid') {
      await client.query('SELECT pg_advisory_xact_lock(hashtext(lower($1)))', [paymentReference]);
      const duplicateReference = await client.query(`
        SELECT id FROM listener_withdrawal_requests
        WHERE id<>$1 AND status='paid' AND lower(payment_reference)=lower($2)
        LIMIT 1
      `, [request.id, paymentReference]);
      if (duplicateReference.rows[0]) {
        throw Object.assign(new Error('This payment reference was already used for another withdrawal.'), { status: 409 });
      }
      const balanceResult = await client.query(`
        SELECT COALESCE(SUM(amount_paise),0)::bigint AS balance_paise
        FROM listener_wallet_transactions WHERE employee_id=$1
      `, [request.employee_id]);
      const balancePaise = Number(balanceResult.rows[0].balance_paise || 0);
      const amountPaise = Number(request.amount_paise || 0);
      if (amountPaise > balancePaise) {
        throw Object.assign(new Error('The listener wallet no longer has enough balance for this withdrawal.'), { status: 409 });
      }
      await client.query(`
        INSERT INTO listener_wallet_transactions(
          employee_id,type,amount_paise,reference_id,payout_upi_id,payout_upi_phone,
          payment_reference,note,created_by
        ) VALUES($1,'payout',$2,$3,$4,$5,$6,$7,$8)
      `, [
        request.employee_id,
        -amountPaise,
        request.id,
        request.payout_upi_id,
        request.payout_upi_phone,
        paymentReference,
        adminNote || 'Listener withdrawal paid',
        req.user.id,
      ]);
    }

    const updated = await client.query(`
      UPDATE listener_withdrawal_requests
      SET status=$2,payment_reference=$3,admin_note=$4,reviewed_by=$5,
          reviewed_at=now(),paid_at=CASE WHEN $2='paid' THEN now() ELSE NULL END,updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [request.id, action, action === 'paid' ? paymentReference : null, adminNote, req.user.id]);
    const formatted = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(request.amount_paise) / 100);
    const title = action === 'paid' ? 'Withdrawal paid' : 'Withdrawal declined';
    const body = action === 'paid'
      ? `${formatted} was paid to your saved payout method. Reference: ${paymentReference}.`
      : `Your ${formatted} withdrawal request was declined.${adminNote ? ` ${adminNote}` : ''}`;
    await client.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [request.employee_id, title, body]);
    return { request: updated.rows[0], employeeId: request.employee_id, notification: { title, body } };
  });

  await req.app.locals.notifyUser?.(output.employeeId, {
    ...output.notification,
    url: './',
    tag: `we-met-withdrawal-${output.request.id}`,
  });
  res.json({ request: { ...output.request, amount_paise: Number(output.request.amount_paise) } });
}));

router.post('/listener-wallets/:id/adjust', asyncHandler(async (req, res) => {
  const amountPaise = integer(req.body.amountPaise, { min: -100_000_000, max: 100_000_000 });
  const note = text(req.body.note, 500);
  if (amountPaise === null || amountPaise === 0) {
    return res.status(400).json({ error: 'Enter a non-zero wallet adjustment.' });
  }
  if (note.length < 3) return res.status(400).json({ error: 'Add a reason for this wallet adjustment.' });

  const output = await db.transaction(async (client) => {
    const employeeResult = await client.query(`
      SELECT id,name FROM users
      WHERE id=$1 AND role='employee'
      FOR UPDATE
    `, [req.params.id]);
    const employee = employeeResult.rows[0];
    if (!employee) throw Object.assign(new Error('Listener not found.'), { status: 404 });

    const balanceResult = await client.query(`
      SELECT COALESCE(SUM(amount_paise),0)::bigint AS balance_paise
      FROM listener_wallet_transactions
      WHERE employee_id=$1
    `, [employee.id]);
    const currentBalance = Number(balanceResult.rows[0].balance_paise || 0);
    const nextBalance = currentBalance + amountPaise;
    if (nextBalance < 0) {
      throw Object.assign(new Error('This adjustment would make the listener wallet negative.'), { status: 409 });
    }
    const pendingResult = await client.query(`
      SELECT COALESCE(SUM(amount_paise),0)::bigint AS reserved_paise
      FROM listener_withdrawal_requests
      WHERE employee_id=$1 AND status='pending'
    `, [employee.id]);
    const reservedPaise = Number(pendingResult.rows[0].reserved_paise || 0);
    if (nextBalance < reservedPaise) {
      throw Object.assign(new Error('This adjustment would reduce the wallet below the amount reserved by a pending withdrawal.'), { status: 409 });
    }

    const transaction = await client.query(`
      INSERT INTO listener_wallet_transactions(employee_id,type,amount_paise,note,created_by)
      VALUES($1,'admin_adjustment',$2,$3,$4)
      RETURNING *
    `, [employee.id, amountPaise, note, req.user.id]);
    const title = 'Listener wallet adjusted';
    const direction = amountPaise > 0 ? 'added to' : 'removed from';
    const formatted = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Math.abs(amountPaise) / 100);
    const body = `${formatted} was ${direction} your listener wallet. ${note}`;
    await client.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [employee.id, title, body]);
    return { employee, transaction: transaction.rows[0], nextBalance, notification: { title, body } };
  });

  await req.app.locals.notifyUser?.(output.employee.id, {
    ...output.notification,
    url: './',
    tag: `we-met-listener-adjustment-${output.transaction.id}`,
  });
  res.json({
    transaction: { ...output.transaction, amount_paise: Number(output.transaction.amount_paise) },
    balancePaise: output.nextBalance,
  });
}));

router.get('/audit-log', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT log.*,admin.name AS admin_name
    FROM admin_audit_log log
    LEFT JOIN users admin ON admin.id=log.admin_id
    ORDER BY log.created_at DESC
    LIMIT 500
  `);
  res.json({ entries: result.rows });
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

module.exports = router;
