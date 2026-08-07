const webPush = require('web-push');
const config = require('./config');
const db = require('./db');

let configured = false;

function enabled() {
  return config.webPush.enabled;
}

function configure() {
  if (!enabled() || configured) return;
  webPush.setVapidDetails(
    config.webPush.subject,
    config.webPush.publicKey,
    config.webPush.privateKey,
  );
  configured = true;
}

function safeText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function notificationPayload(payload = {}) {
  return JSON.stringify({
    title: safeText(payload.title, 120) || config.appName,
    body: safeText(payload.body, 500),
    url: safeText(payload.url, 500) || './',
    tag: safeText(payload.tag, 160) || 'we-met-update',
    icon: safeText(payload.icon, 300) || 'assets/icon-192.png',
    badge: safeText(payload.badge, 300) || 'assets/favicon.png',
    requireInteraction: payload.requireInteraction === true,
    renotify: payload.renotify === true,
    silent: payload.silent === true,
    vibrate: payload.silent === true
      ? []
      : Array.isArray(payload.vibrate)
      ? payload.vibrate.slice(0, 8).map((value) => Math.max(0, Math.min(2000, Number(value) || 0)))
      : [180, 80, 180],
  });
}

async function removeExpired(endpoints) {
  if (!endpoints.length) return;
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])', [endpoints]);
}

async function sendToUser(userId, payload) {
  if (!enabled() || !userId) return { sent: 0, removed: 0 };

  const account = await db.query('SELECT role FROM users WHERE id=$1', [userId]);
  if (account.rows[0]?.role === 'employee') {
    await db.query('DELETE FROM push_subscriptions WHERE user_id=$1', [userId]);
    return { sent: 0, removed: 0 };
  }

  configure();
  const result = await db.query(`
    SELECT endpoint,p256dh,auth
    FROM push_subscriptions
    WHERE user_id=$1
    ORDER BY updated_at DESC
    LIMIT 12
  `, [userId]);
  if (!result.rows.length) return { sent: 0, removed: 0 };

  const message = notificationPayload(payload);
  const expired = [];
  let sent = 0;
  const ttl = Math.max(30, Math.min(86400, Number(payload?.ttl) || 3600));

  await Promise.all(result.rows.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, message, { TTL: ttl, urgency: payload?.urgency === 'high' ? 'high' : 'normal' });
      sent += 1;
    } catch (error) {
      if ([404, 410].includes(Number(error?.statusCode))) {
        expired.push(subscription.endpoint);
        return;
      }
      console.error('Web Push delivery failed:', error?.statusCode || error?.message || error);
    }
  }));

  await removeExpired(expired);
  return { sent, removed: expired.length };
}

module.exports = {
  enabled,
  publicKey: () => (enabled() ? config.webPush.publicKey : ''),
  notificationPayload,
  sendToUser,
};
