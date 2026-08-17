const express = require('express');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('employee'));

function normaliseUpiId(value) {
  const upiId = String(value || '').trim().toLowerCase().slice(0, 120);
  if (!upiId) return null;
  return /^[a-z0-9._-]{2,100}@[a-z0-9.-]{2,40}$/.test(upiId) ? upiId : false;
}

function normaliseUpiPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return false;
}

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
  const [summaryResult, transactionsResult] = await Promise.all([
    db.query(`
      SELECT u.upi_id,u.upi_phone,u.listener_rate_paise,
             COALESCE(SUM(t.amount_paise),0)::bigint AS balance_paise,
             COALESCE(SUM(t.amount_paise) FILTER (WHERE t.type='call_credit'),0)::bigint AS lifetime_earnings_paise,
             COALESCE(SUM(-t.amount_paise) FILTER (WHERE t.type='payout'),0)::bigint AS lifetime_paid_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type='call_credit' AND t.created_at>=date_trunc('day',now())
             ),0)::bigint AS today_earnings_paise,
             COALESCE(SUM(t.amount_paise) FILTER (
               WHERE t.type='call_credit' AND t.created_at>=now()-interval '7 days'
             ),0)::bigint AS week_earnings_paise
      FROM users u
      LEFT JOIN listener_wallet_transactions t ON t.employee_id=u.id
      WHERE u.id=$1 AND u.role='employee'
      GROUP BY u.id,u.upi_id,u.upi_phone,u.listener_rate_paise
    `, [req.user.id]),
    db.query(`
      SELECT t.id,t.type,t.amount_paise,t.billed_seconds,t.rate_paise_per_minute,
             t.payout_upi_id,t.payout_upi_phone,t.payment_reference,t.note,t.created_at,
             c.started_at AS call_started_at,c.ended_at AS call_ended_at
      FROM listener_wallet_transactions t
      LEFT JOIN calls c ON c.id=t.reference_id AND t.type='call_credit'
      WHERE t.employee_id=$1
      ORDER BY t.created_at DESC
      LIMIT 250
    `, [req.user.id]),
  ]);

  const row = summaryResult.rows[0];
  if (!row) return res.status(404).json({ error: 'Listener wallet not found.' });
  res.json({
    summary: {
      upiId: row.upi_id,
      upiPhone: row.upi_phone,
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
  });
}));

router.patch('/wallet/payout-details', asyncHandler(async (req, res) => {
  const upiId = normaliseUpiId(req.body.upiId);
  const upiPhone = normaliseUpiPhone(req.body.upiPhone);
  if (upiId === false) return res.status(400).json({ error: 'Enter a valid UPI ID, for example name@bank.' });
  if (upiPhone === false) return res.status(400).json({ error: 'Enter a valid UPI-linked mobile number.' });
  if (!upiId && !upiPhone) return res.status(400).json({ error: 'Add a UPI ID or UPI-linked mobile number.' });

  const result = await db.query(`
    UPDATE users
    SET upi_id=$2,upi_phone=$3,updated_at=now()
    WHERE id=$1 AND role='employee'
    RETURNING upi_id,upi_phone
  `, [req.user.id, upiId, upiPhone]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Listener account not found.' });
  res.json({ upiId: result.rows[0].upi_id, upiPhone: result.rows[0].upi_phone });
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
  const name = String(req.body.name || '').trim().slice(0, 80);
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 50) || null;
  const phone = String(req.body.phone || '').trim().slice(0, 30) || null;
  const bio = String(req.body.bio || '').trim().slice(0, 500) || null;
  if (name.length < 2) return res.status(400).json({ error: 'Enter a display name.' });

  try {
    const result = await db.query(
      `UPDATE users SET name=$2,username=$3,phone=$4,bio=$5,updated_at=now()
       WHERE id=$1 RETURNING id,name,username,email,phone,upi_id,upi_phone,bio,employee_code,listener_language,listener_rate_paise`,
      [req.user.id, name, username, phone, bio],
    );
    res.json({ user: result.rows[0] });
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
