const express = require('express');
const db = require('../db');
const push = require('../push');
const { authenticate, asyncHandler } = require('../middleware');

const router = express.Router();
router.use(authenticate);

function subscriptionFrom(body = {}) {
  const endpoint = String(body.endpoint || '').trim().slice(0, 4000);
  const p256dh = String(body.keys?.p256dh || '').trim().slice(0, 300);
  const auth = String(body.keys?.auth || '').trim().slice(0, 200);

  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { endpointUrl = null; }
  if (!endpointUrl || endpointUrl.protocol !== 'https:') return null;
  if (!/^[A-Za-z0-9_-]{40,300}$/.test(p256dh)) return null;
  if (!/^[A-Za-z0-9_-]{12,200}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

router.post('/subscriptions', asyncHandler(async (req, res) => {
  if (!push.enabled()) return res.status(503).json({ error: 'Push notifications are not configured yet.' });
  const subscription = subscriptionFrom(req.body);
  if (!subscription) return res.status(400).json({ error: 'The push subscription is invalid.' });

  await db.transaction(async (client) => {
    await client.query(`
      INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id=EXCLUDED.user_id,
        p256dh=EXCLUDED.p256dh,
        auth=EXCLUDED.auth,
        user_agent=EXCLUDED.user_agent,
        updated_at=now()
    `, [
      req.user.id,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      String(req.get('user-agent') || '').slice(0, 500) || null,
    ]);

    await client.query(`
      DELETE FROM push_subscriptions
      WHERE user_id=$1 AND id NOT IN (
        SELECT id FROM push_subscriptions
        WHERE user_id=$1
        ORDER BY updated_at DESC
        LIMIT 8
      )
    `, [req.user.id]);
  });

  return res.status(201).json({ ok: true });
}));

router.delete('/subscriptions', asyncHandler(async (req, res) => {
  const endpoint = String(req.body.endpoint || '').trim().slice(0, 4000);
  if (endpoint) {
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [req.user.id, endpoint],
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
