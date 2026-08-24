'use strict';

const express = require('express');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const { profileImageReference } = require('../profile-image');
const { listenerPublicName } = require('../subscription-access');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

router.use((req, res, next) => {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const route = String(req.originalUrl || '').split('?')[0];
  const requestIp = req.ip;
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const uuidMatch = route.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i);
    db.query(`
      INSERT INTO admin_audit_log(admin_id,action,target_type,target_id,route,ip_address,user_agent,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    `, [
      req.user.id,
      `${req.method} ${route}`,
      route.split('/').filter(Boolean).at(2) || null,
      uuidMatch?.[0] || null,
      route,
      requestIp,
      userAgent,
      JSON.stringify({ statusCode: res.statusCode }),
    ]).catch((error) => console.error('Admin social audit log failed:', error));
  });
  return next();
});

router.get('/verifications', asyncHandler(async (_req, res) => {
  const [setting, submissions] = await Promise.all([
    db.query("SELECT value,updated_at FROM platform_settings WHERE key='listener_verification_prompt'"),
    db.query(`
      SELECT v.id,v.employee_id,v.prompt_text,v.audio_mime,v.audio_size,v.status,
             v.admin_note,v.reviewed_at,v.created_at,v.updated_at,
             u.name,u.username,u.phone,u.profile_image,u.listener_verification_status
      FROM listener_verifications v
      JOIN users u ON u.id=v.employee_id
      ORDER BY (v.status='pending') DESC,v.created_at DESC
      LIMIT 500
    `),
  ]);
  res.json({
    prompt: setting.rows[0]?.value || 'ഞാൻ വി മെറ്റിൽ ആദരവോടെയും ഉത്തരവാദിത്തത്തോടെയും സംസാരിക്കും.',
    promptUpdatedAt: setting.rows[0]?.updated_at || null,
    submissions: submissions.rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      privateName: row.name,
      publicName: listenerPublicName(row),
      phone: row.phone,
      profileImage: profileImageReference(row.profile_image, row.employee_id),
      promptText: row.prompt_text,
      audioMime: row.audio_mime,
      audioSize: Number(row.audio_size || 0),
      status: row.status,
      accountStatus: row.listener_verification_status,
      adminNote: row.admin_note,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      audioUrl: `/api/admin/verifications/${row.id}/audio`,
    })),
  });
}));

router.patch('/verification-prompt', asyncHandler(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 500);
  if (prompt.length < 10) return res.status(400).json({ error: 'Enter a clear Malayalam verification line.' });
  const result = await db.query(`
    INSERT INTO platform_settings(key,value,updated_by,updated_at)
    VALUES('listener_verification_prompt',$1,$2,now())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING value,updated_at
  `, [prompt, req.user.id]);
  res.json({ prompt: result.rows[0].value, updatedAt: result.rows[0].updated_at });
}));

router.get('/verifications/:id/audio', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT audio_mime,audio_size,audio_data
    FROM listener_verifications WHERE id=$1
  `, [req.params.id]);
  const audio = result.rows[0];
  if (!audio) return res.status(404).end();
  res.setHeader('Content-Type', audio.audio_mime);
  res.setHeader('Content-Length', String(audio.audio_size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(audio.audio_data);
}));

router.patch('/verifications/:id', asyncHandler(async (req, res) => {
  const action = String(req.body.action || '');
  const note = String(req.body.note || '').trim().slice(0, 1000) || null;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Choose approve or reject.' });
  if (action === 'reject' && !note) return res.status(400).json({ error: 'Add a short reason so the listener knows what to record again.' });

  const output = await db.transaction(async (client) => {
    const found = await client.query('SELECT * FROM listener_verifications WHERE id=$1 FOR UPDATE', [req.params.id]);
    const submission = found.rows[0];
    if (!submission) throw Object.assign(new Error('Verification recording not found.'), { status: 404 });
    if (submission.status !== 'pending') throw Object.assign(new Error('This recording was already reviewed.'), { status: 409 });
    const status = action === 'approve' ? 'approved' : 'rejected';
    await client.query(`
      UPDATE listener_verifications
      SET status=$2,admin_note=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now()
      WHERE id=$1
    `, [submission.id, status, note, req.user.id]);
    const user = await client.query(`
      UPDATE users
      SET listener_verification_status=$2,
          listener_verification_note=$3,
          listener_verified_at=CASE WHEN $2='approved' THEN now() ELSE listener_verified_at END,
          listener_availability=CASE WHEN $2='approved' THEN listener_availability ELSE 'offline' END,
          updated_at=now()
      WHERE id=$1 AND role='employee'
      RETURNING id,name,username
    `, [submission.employee_id, status, note]);
    const title = action === 'approve' ? 'Listener account verified' : 'New voice recording needed';
    const body = action === 'approve'
      ? 'Your listener account is active. Complete your profile, add photos and go online when ready.'
      : `Your voice recording was not approved.${note ? ` ${note}` : ''}`;
    await client.query('INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)', [submission.employee_id, title, body]);
    return { employee: user.rows[0], title, body };
  });

  await req.app.locals.socketRuntime?.refreshEmployeeProfile?.(output.employee.id);
  await req.app.locals.notifyUser?.(output.employee.id, {
    title: output.title,
    body: output.body,
    url: './',
    tag: `we-met-verification-${req.params.id}`,
  });
  res.json({ ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
}));

router.get('/subscriptions', asyncHandler(async (_req, res) => {
  const [subscriptions, payments, topups, summary] = await Promise.all([
    db.query(`
      SELECT s.id,s.razorpay_subscription_id,s.status,s.current_period_start,
             s.current_period_end,s.cancel_at_cycle_end,s.paid_count,s.created_at,s.updated_at,
             c.id AS customer_id,c.name AS customer_name,c.phone AS customer_phone,
             e.id AS employee_id,e.name AS employee_private_name,e.username AS employee_username
      FROM listener_subscriptions s
      JOIN users c ON c.id=s.customer_id
      JOIN users e ON e.id=s.employee_id
      ORDER BY s.updated_at DESC LIMIT 1000
    `),
    db.query(`
      SELECT p.id,p.razorpay_payment_id,p.amount_paise,p.listener_credit_paise,p.status,p.paid_at,
             c.name AS customer_name,e.name AS employee_private_name,e.username AS employee_username
      FROM listener_subscription_payments p
      JOIN users c ON c.id=p.customer_id
      JOIN users e ON e.id=p.employee_id
      ORDER BY p.paid_at DESC LIMIT 1000
    `),
    db.query(`
      SELECT o.id,o.razorpay_order_id,o.razorpay_payment_id,o.plan_name,o.amount_paise,
             o.seconds,o.status,o.paid_at,o.created_at,u.name AS customer_name
      FROM razorpay_orders o JOIN users u ON u.id=o.customer_id
      ORDER BY o.created_at DESC LIMIT 1000
    `),
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active' AND current_period_end>now())::int AS active_subscriptions,
        COUNT(*)::int AS all_subscriptions
      FROM listener_subscriptions
    `),
  ]);
  const captured = payments.rows.filter((row) => row.status === 'captured');
  res.json({
    summary: {
      activeSubscriptions: Number(summary.rows[0]?.active_subscriptions || 0),
      allSubscriptions: Number(summary.rows[0]?.all_subscriptions || 0),
      subscriptionRevenuePaise: captured.reduce((total, row) => total + Number(row.amount_paise || 0), 0),
      listenerCreditsPaise: captured.reduce((total, row) => total + Number(row.listener_credit_paise || 0), 0),
      topupRevenuePaise: topups.rows.filter((row) => row.status === 'paid').reduce((total, row) => total + Number(row.amount_paise || 0), 0),
    },
    subscriptions: subscriptions.rows.map((row) => ({
      ...row,
      listener_name: listenerPublicName({ username: row.employee_username, name: row.employee_private_name }),
    })),
    payments: payments.rows.map((row) => ({
      ...row,
      listener_name: listenerPublicName({ username: row.employee_username, name: row.employee_private_name }),
    })),
    topups: topups.rows,
  });
}));

router.get('/posts', asyncHandler(async (_req, res) => {
  const result = await db.query(`
    SELECT p.id,p.employee_id,p.caption,p.image_mime,p.image_size,p.created_at,
           u.name AS private_name,u.username
    FROM listener_posts p
    JOIN users u ON u.id=p.employee_id
    ORDER BY p.created_at DESC
    LIMIT 1000
  `);
  res.json({ posts: result.rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    listenerName: listenerPublicName({ username: row.username, name: row.private_name }),
    privateName: row.private_name,
    caption: row.caption,
    imageMime: row.image_mime,
    imageSize: Number(row.image_size || 0),
    createdAt: row.created_at,
    imageUrl: `/api/admin/posts/${row.id}/image`,
  })) });
}));

router.get('/posts/:id/image', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT image_mime,image_size,image_data FROM listener_posts WHERE id=$1', [req.params.id]);
  const post = result.rows[0];
  if (!post) return res.status(404).end();
  res.setHeader('Content-Type', post.image_mime);
  res.setHeader('Content-Length', String(post.image_size));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(post.image_data);
}));

router.delete('/posts/:id', asyncHandler(async (req, res) => {
  const result = await db.query('DELETE FROM listener_posts WHERE id=$1 RETURNING id,employee_id', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Listener photo not found.' });
  res.json({ ok: true });
}));

module.exports = router;
