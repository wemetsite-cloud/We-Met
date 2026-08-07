const express = require('express');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate, requireRole('employee'));

router.get('/history', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT c.id,c.customer_id,c.status,c.started_at,c.ended_at,c.billed_seconds,
            c.end_reason,c.created_at,u.name customer_name
     FROM calls c JOIN users u ON u.id=c.customer_id
     WHERE c.employee_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
    [req.user.id],
  );
  res.json({ calls: result.rows });
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='ended')::int total_calls,
            COALESCE(SUM(billed_seconds) FILTER (WHERE status='ended'),0)::int total_seconds,
            COALESCE(SUM(billed_seconds) FILTER (WHERE status='ended' AND started_at::date=CURRENT_DATE),0)::int today_seconds
     FROM calls WHERE employee_id=$1`,
    [req.user.id],
  );
  res.json({ stats: result.rows[0] });
}));

router.patch('/profile', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 50) || null;
  const phone = String(req.body.phone || '').trim().slice(0, 30) || null;
  const upiId = String(req.body.upiId || '').trim().slice(0, 100) || null;
  const bio = String(req.body.bio || '').trim().slice(0, 500) || null;
  if (name.length < 2) return res.status(400).json({ error: 'Enter a display name.' });

  try {
    const result = await db.query(
      `UPDATE users SET name=$2,username=$3,phone=$4,upi_id=$5,bio=$6,updated_at=now()
       WHERE id=$1 RETURNING id,name,username,email,phone,upi_id,bio,employee_code`,
      [req.user.id, name, username, phone, upiId, bio],
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
