const express = require('express');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const { normalizeProfileImage } = require('../profile-image');
const { normalizePhone } = require('../phone');

const router = express.Router();
router.use(authenticate, requireRole('employee'));

router.get('/history', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT c.id,c.customer_id,c.status,c.started_at,c.ended_at,c.billed_seconds,
            c.listener_rate_paise,c.listener_earnings_paise,c.earnings_settled_at,
            c.end_reason,c.created_at,u.name customer_name
     FROM calls c JOIN users u ON u.id=c.customer_id
     WHERE c.employee_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
    [req.user.id],
  );
  res.json({ calls: result.rows });
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const [calls, activity] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE started_at IS NOT NULL)::int total_calls,
              COALESCE(SUM(billed_seconds),0)::bigint total_seconds,
              COALESCE(SUM(billed_seconds) FILTER (WHERE created_at>=date_trunc('day',now())),0)::bigint today_seconds,
              COALESCE(SUM(billed_seconds) FILTER (WHERE created_at>=now()-interval '7 days'),0)::bigint week_seconds
       FROM calls WHERE employee_id=$1`,
      [req.user.id],
    ),
    db.query(`
      SELECT MAX(started_at) FILTER (WHERE ended_at IS NULL) AS current_activity_started_at
      FROM listener_activity_sessions
      WHERE employee_id=$1
    `, [req.user.id]),
  ]);
  res.json({ stats: { ...calls.rows[0], ...activity.rows[0] } });
}));

router.get('/wallet', asyncHandler(async (req, res) => {
  const [summaryResult, transactionsResult, payoutResult, withdrawalResult] = await Promise.all([
    db.query(`
      SELECT u.listener_rate_paise,
             COALESCE(SUM(t.amount_paise),0)::bigint AS balance_paise,
             COALESCE(SUM(t.amount_paise) FILTER (WHERE t.type IN ('call_credit','subscription_credit')),0)::bigint AS lifetime_earnings_paise,
             COALESCE(SUM(-t.amount_paise) FILTER (WHERE t.type='payout'),0)::bigint AS lifetime_paid_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type IN ('call_credit','subscription_credit') AND t.created_at>=date_trunc('day',now())
             ),0)::bigint AS today_earnings_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type IN ('call_credit','subscription_credit') AND t.created_at>=now()-interval '7 days'
             ),0)::bigint AS week_earnings_paise
      FROM users u
      LEFT JOIN listener_wallet_transactions t ON t.employee_id=u.id
      WHERE u.id=$1 AND u.role='employee'
      GROUP BY u.id,u.listener_rate_paise
    `, [req.user.id]),
    db.query(`
      SELECT t.id,t.type,t.amount_paise,t.billed_seconds,t.rate_paise_per_minute,
             t.payment_reference,t.note,t.created_at,
             c.started_at AS call_started_at,c.ended_at AS call_ended_at
      FROM listener_wallet_transactions t
      LEFT JOIN calls c ON c.id=t.reference_id AND t.type='call_credit'
      WHERE t.employee_id=$1
      ORDER BY t.created_at DESC
      LIMIT 250
    `, [req.user.id]),
    db.query(`SELECT upi_id,upi_phone FROM users WHERE id=$1 AND role='employee'`, [req.user.id]),
    db.query(`
      SELECT id,amount_paise,payout_upi_id,payout_upi_phone,listener_note,status,
             payment_reference,admin_note,requested_at,reviewed_at,paid_at
      FROM listener_withdrawal_requests
      WHERE employee_id=$1 ORDER BY requested_at DESC LIMIT 50
    `, [req.user.id]),
  ]);

  const row = summaryResult.rows[0];
  if (!row) return res.status(404).json({ error: 'Listener wallet not found.' });
  res.json({
    summary: {
      ratePaisePerMinute: Number(row.listener_rate_paise || 0),
      balancePaise: Number(row.balance_paise || 0),
      lifetimeEarningsPaise: Number(row.lifetime_earnings_paise || 0),
      lifetimePaidPaise: Number(row.lifetime_paid_paise || 0),
      todayEarningsPaise: Number(row.today_earnings_paise || 0),
      weekEarningsPaise: Number(row.week_earnings_paise || 0),
    },
    transactions: transactionsResult.rows.map((entry) => ({
      ...entry,
      amount_paise: Number(entry.amount_paise || 0),
      billed_seconds: entry.billed_seconds === null ? null : Number(entry.billed_seconds),
      rate_paise_per_minute: entry.rate_paise_per_minute === null ? null : Number(entry.rate_paise_per_minute),
    })),
    payoutDetails: {
      upiId: payoutResult.rows[0]?.upi_id || '',
      upiPhone: payoutResult.rows[0]?.upi_phone || '',
    },
    withdrawals: withdrawalResult.rows.map((entry) => ({ ...entry, amount_paise: Number(entry.amount_paise || 0) })),
  });
}));

router.patch('/payout-details', asyncHandler(async (req, res) => {
  const upiId = String(req.body.upiId || '').trim().toLowerCase().slice(0, 180);
  const requestedPhone = String(req.body.upiPhone || '').trim();
  const upiPhone = requestedPhone ? normalizePhone(requestedPhone) : null;
  if (!/^[a-z0-9._-]{2,120}@[a-z]{2,64}$/i.test(upiId)) {
    return res.status(400).json({ error: 'Enter a valid UPI ID, such as name@bank.' });
  }
  if (!requestedPhone || !upiPhone) return res.status(400).json({ error: 'Enter the UPI-linked phone number with country code.' });
  const result = await db.query(`
    UPDATE users SET upi_id=$2,upi_phone=$3,updated_at=now()
    WHERE id=$1 AND role='employee'
    RETURNING upi_id,upi_phone
  `, [req.user.id, upiId, upiPhone]);
  res.json({ payoutDetails: { upiId: result.rows[0].upi_id, upiPhone: result.rows[0].upi_phone || '' } });
}));

router.post('/withdrawals', asyncHandler(async (req, res) => {
  const amountPaise = Number(req.body.amountPaise);
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  if (!Number.isInteger(amountPaise) || amountPaise < 10_000 || amountPaise > 100_000_000) {
    return res.status(400).json({ error: 'Withdrawal requests must be at least ₹100.' });
  }

  const output = await db.transaction(async (client) => {
    const userResult = await client.query(`
      SELECT id,name,upi_id,upi_phone FROM users
      WHERE id=$1 AND role='employee' FOR UPDATE
    `, [req.user.id]);
    const listener = userResult.rows[0];
    if (!listener) throw Object.assign(new Error('Listener account not found.'), { status: 404 });
    if (!listener.upi_id) throw Object.assign(new Error('Save your UPI ID before requesting a withdrawal.'), { status: 400 });

    const pending = await client.query(`
      SELECT id FROM listener_withdrawal_requests
      WHERE employee_id=$1 AND status='pending' LIMIT 1
    `, [listener.id]);
    if (pending.rows[0]) throw Object.assign(new Error('You already have a withdrawal under review.'), { status: 409 });

    const balanceResult = await client.query(`
      SELECT COALESCE(SUM(amount_paise),0)::bigint AS balance_paise
      FROM listener_wallet_transactions WHERE employee_id=$1
    `, [listener.id]);
    const balancePaise = Number(balanceResult.rows[0].balance_paise || 0);
    if (amountPaise > balancePaise) throw Object.assign(new Error('The requested amount is higher than your available earnings.'), { status: 409 });

    const created = await client.query(`
      INSERT INTO listener_withdrawal_requests(
        employee_id,amount_paise,payout_upi_id,payout_upi_phone,listener_note
      ) VALUES($1,$2,$3,$4,$5)
      RETURNING id,amount_paise,status,requested_at
    `, [listener.id, amountPaise, listener.upi_id, listener.upi_phone, note]);
    await client.query(`
      INSERT INTO notifications(user_id,title,body)
      SELECT id,'New listener withdrawal',$1 FROM users WHERE role='admin'
    `, [`${listener.name} requested ₹${(amountPaise / 100).toFixed(2)} to ${listener.upi_id}.`]);
    return created.rows[0];
  });

  res.status(201).json({
    withdrawal: { ...output, amount_paise: Number(output.amount_paise) },
    message: 'Withdrawal requested. The administrator will review it within 24 hours.',
  });
}));

router.get('/activity', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id,state,started_at,ended_at,
           CASE WHEN ended_at IS NULL THEN GREATEST(0,EXTRACT(EPOCH FROM (now()-started_at))::int) ELSE duration_seconds END AS duration_seconds,
           end_reason
    FROM listener_activity_sessions
    WHERE employee_id=$1
    ORDER BY started_at DESC
    LIMIT 50
  `, [req.user.id]);
  res.json({ sessions: result.rows });
}));

router.patch('/profile', asyncHandler(async (req, res) => {
  if (req.user.listener_verification_status !== 'approved') {
    return res.status(403).json({ error: 'Your voice verification must be approved before editing the public profile.' });
  }
  const name = String(req.body.name || '').trim().slice(0, 80);
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 50) || null;
  const bio = String(req.body.bio || '').trim().slice(0, 500) || null;
  const profileImage = normalizeProfileImage(req.body.profileImage);
  const bannerImage = normalizeProfileImage(req.body.bannerImage);
  if (name.length < 2) return res.status(400).json({ error: 'Enter your private original name.' });
  if (profileImage === false) return res.status(400).json({ error: 'Upload a valid JPG, PNG, or WebP profile photo.' });
  if (bannerImage === false) return res.status(400).json({ error: 'Choose a valid JPG, PNG, or WebP banner photo.' });

  try {
    const result = await db.query(
      `UPDATE users SET name=$2,username=$3,bio=$4,
       profile_image=CASE WHEN $5::boolean THEN $6 ELSE profile_image END,
       banner_image=CASE WHEN $7::boolean THEN $8 ELSE banner_image END,
       updated_at=now()
       WHERE id=$1 RETURNING id,name,username,email,phone,bio,profile_image,banner_image,employee_code,listener_language,listener_rate_paise,updated_at`,
      [
        req.user.id, name, username, bio,
        profileImage !== undefined, profileImage === undefined ? null : profileImage,
        bannerImage !== undefined, bannerImage === undefined ? null : bannerImage,
      ],
    );
    await req.app.locals.socketRuntime?.refreshEmployeeProfile?.(req.user.id);
    const user = result.rows[0];
    if (String(user.profile_image || '').startsWith('data:image/')) user.profile_image = `photo:${user.id}`;
    if (String(user.banner_image || '').startsWith('data:image/')) user.banner_image = `photo:${user.id}`;
    res.json({ user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
}));

router.post('/reports', asyncHandler(async (req, res) => {
  const callId = req.body.callId || null;
  const reason = String(req.body.reason || '').trim().slice(0, 250);
  const details = String(req.body.details || '').trim().slice(0, 2000);
  const priority = req.body.priority === 'high' ? 'high' : 'normal';
  if (reason.length < 3) return res.status(400).json({ error: 'Describe the reason for the report.' });

  let targetId = null;
  if (callId) {
    const call = await db.query('SELECT customer_id FROM calls WHERE id=$1 AND employee_id=$2', [callId, req.user.id]);
    if (!call.rows[0]) return res.status(404).json({ error: 'Call not found.' });
    targetId = call.rows[0].customer_id;
  }

  const result = await db.query(
    `INSERT INTO reports(call_id,reporter_id,target_id,reason,details,priority)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [callId, req.user.id, targetId, reason, details || null, priority],
  );
  res.status(201).json({ report: result.rows[0] });
}));

router.get('/notifications', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: result.rows });
}));

module.exports = router;
