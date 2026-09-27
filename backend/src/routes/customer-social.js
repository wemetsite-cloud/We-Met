'use strict';

const express = require('express');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const { normalizeProfileImage, decodeProfileImage, profileImageReference } = require('../profile-image');
const { activeSubscription, requireActiveSubscription, listenerPublicName } = require('../subscription-access');
const { reconcileCustomerSubscriptions } = require('./subscriptions');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

function listenerImageReference(user) {
  return profileImageReference(user.profile_image, user.id);
}

function listenerBannerReference(user) {
  return profileImageReference(user.banner_image, user.id);
}

async function listenerDirectory(customerId, employeeId = null) {
  const params = [customerId];
  const whereId = employeeId ? 'AND u.id=$2' : '';
  if (employeeId) params.push(employeeId);
  const result = await db.query(`
    SELECT u.id,u.name,u.username,u.bio,u.profile_image,u.banner_image,u.updated_at,
           u.listener_language,u.listener_availability,u.last_seen_at,
           EXISTS(SELECT 1 FROM listener_follows f WHERE f.customer_id=$1 AND f.employee_id=u.id) AS following,
           EXISTS(
             SELECT 1 FROM listener_subscriptions s
             WHERE s.customer_id=$1 AND s.employee_id=u.id
               AND (
                 (s.access_source='admin' AND s.status='active' AND s.revoked_at IS NULL)
                 OR (
                   s.access_source='razorpay'
                   AND s.status IN ('active','cancelled','completed')
                   AND s.current_period_end>now()
                   AND (
                     s.paid_count>0
                     OR EXISTS(
                       SELECT 1 FROM listener_subscription_payments payment
                       WHERE payment.subscription_id=s.id AND payment.status='captured'
                     )
                   )
                 )
               )
           ) AS subscribed,
           (SELECT COUNT(*)::int FROM listener_posts p WHERE p.employee_id=u.id) AS post_count
    FROM users u
    WHERE u.role='employee' AND u.status='active'
      AND u.listener_verification_status='approved'
      AND NOT EXISTS(
        SELECT 1 FROM customer_blocks block
        WHERE block.customer_id=$1 AND block.employee_id=u.id
      )
      ${whereId}
    ORDER BY CASE u.listener_availability WHEN 'online' THEN 0 WHEN 'break' THEN 1 ELSE 2 END,
             COALESCE(u.username,u.name)
    LIMIT 500
  `, params);
  return result.rows.map((row) => ({
    id: row.id,
    name: listenerPublicName(row),
    bio: row.bio || 'A friendly listener ready for respectful conversation.',
    profileImage: listenerImageReference(row),
    bannerImage: listenerBannerReference(row),
    language: row.listener_language || 'Malayalam',
    availability: row.listener_availability || 'offline',
    following: Boolean(row.following),
    subscribed: Boolean(row.subscribed),
    postCount: Number(row.post_count || 0),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  }));
}

router.get('/listeners', asyncHandler(async (req, res) => {
  res.json({ listeners: await listenerDirectory(req.user.id) });
}));

router.get('/following', asyncHandler(async (req, res) => {
  const listeners = await listenerDirectory(req.user.id);
  res.json({ listeners: listeners.filter((listener) => listener.following) });
}));

router.get('/listeners/:id/profile', asyncHandler(async (req, res) => {
  const listeners = await listenerDirectory(req.user.id, req.params.id);
  const listener = listeners[0];
  if (!listener) return res.status(404).json({ error: 'Listener not found.' });

  let posts = [];
  if (listener.subscribed) {
    const postResult = await db.query(`
      SELECT p.id,p.caption,p.image_mime,p.image_size,p.created_at,
             EXISTS(
               SELECT 1 FROM listener_post_likes likes
               WHERE likes.post_id=p.id AND likes.customer_id=$2
             ) AS liked
      FROM listener_posts p WHERE p.employee_id=$1
      ORDER BY created_at DESC LIMIT 60
    `, [listener.id, req.user.id]);
    posts = postResult.rows.map((post) => ({ ...post, liked: Boolean(post.liked), imageUrl: `/api/customer/listener-posts/${post.id}/image` }));
  }
  res.json({ listener, posts, postsLocked: !listener.subscribed && listener.postCount > 0 });
}));

router.get('/listener-posts/:postId/image', asyncHandler(async (req, res) => {
  const post = await db.query(`
    SELECT id,employee_id,image_mime,image_size,image_data
    FROM listener_posts WHERE id=$1
  `, [req.params.postId]);
  const row = post.rows[0];
  if (!row) return res.status(404).end();
  await requireActiveSubscription(db, req.user.id, row.employee_id);
  res.setHeader('Content-Type', row.image_mime);
  res.setHeader('Content-Length', String(row.image_size));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(row.image_data);
}));

router.post('/listener-posts/:postId/like', asyncHandler(async (req, res) => {
  const post = await db.query('SELECT employee_id FROM listener_posts WHERE id=$1', [req.params.postId]);
  if (!post.rows[0]) return res.status(404).json({ error: 'Post not found.' });
  await requireActiveSubscription(db, req.user.id, post.rows[0].employee_id);
  await db.query(`
    INSERT INTO listener_post_likes(post_id,customer_id)
    VALUES($1,$2) ON CONFLICT DO NOTHING
  `, [req.params.postId, req.user.id]);
  res.json({ ok: true, liked: true });
}));

router.delete('/listener-posts/:postId/like', asyncHandler(async (req, res) => {
  const post = await db.query('SELECT employee_id FROM listener_posts WHERE id=$1', [req.params.postId]);
  if (!post.rows[0]) return res.status(404).json({ error: 'Post not found.' });
  await requireActiveSubscription(db, req.user.id, post.rows[0].employee_id);
  await db.query('DELETE FROM listener_post_likes WHERE post_id=$1 AND customer_id=$2', [req.params.postId, req.user.id]);
  res.json({ ok: true, liked: false });
}));

router.post('/listeners/:id/follow', asyncHandler(async (req, res) => {
  const listener = await db.query(`
    SELECT id FROM users
    WHERE id=$1 AND role='employee' AND status='active' AND listener_verification_status='approved'
  `, [req.params.id]);
  if (!listener.rows[0]) return res.status(404).json({ error: 'Listener not found.' });
  await db.query(`
    INSERT INTO listener_follows(customer_id,employee_id)
    VALUES($1,$2) ON CONFLICT DO NOTHING
  `, [req.user.id, req.params.id]);
  res.json({ ok: true, following: true });
}));

router.delete('/listeners/:id/follow', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM listener_follows WHERE customer_id=$1 AND employee_id=$2', [req.user.id, req.params.id]);
  res.json({ ok: true, following: false });
}));

router.get('/blocks', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT block.employee_id,block.reason,block.created_at,u.name,u.username
    FROM customer_blocks block JOIN users u ON u.id=block.employee_id
    WHERE block.customer_id=$1 ORDER BY block.created_at DESC
  `, [req.user.id]);
  res.json({ blocks: result.rows });
}));

router.post('/blocks/:employeeId', asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 250) || null;
  const listener = await db.query("SELECT id FROM users WHERE id=$1 AND role='employee'", [req.params.employeeId]);
  if (!listener.rows[0]) return res.status(404).json({ error: 'Listener not found.' });
  await db.query(`
    INSERT INTO customer_blocks(customer_id,employee_id,reason)
    VALUES($1,$2,$3) ON CONFLICT(customer_id,employee_id) DO UPDATE SET reason=EXCLUDED.reason,created_at=now()
  `, [req.user.id, req.params.employeeId, reason]);
  await db.query('DELETE FROM listener_follows WHERE customer_id=$1 AND employee_id=$2', [req.user.id, req.params.employeeId]);
  res.json({ ok: true, blocked: true });
}));

router.delete('/blocks/:employeeId', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM customer_blocks WHERE customer_id=$1 AND employee_id=$2', [req.user.id, req.params.employeeId]);
  res.json({ ok: true, blocked: false });
}));

router.post('/reports/listener/:employeeId', asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 250);
  const details = String(req.body.details || '').trim().slice(0, 2000);
  if (reason.length < 3) return res.status(400).json({ error: 'Describe why you are reporting this listener.' });
  const listener = await db.query("SELECT id FROM users WHERE id=$1 AND role='employee'", [req.params.employeeId]);
  if (!listener.rows[0]) return res.status(404).json({ error: 'Listener not found.' });
  const result = await db.query(`
    INSERT INTO reports(reporter_id,target_id,reason,details,priority)
    VALUES($1,$2,$3,$4,'normal') RETURNING id
  `, [req.user.id, req.params.employeeId, reason, details || null]);
  res.status(201).json({ report: result.rows[0] });
}));

router.post('/reports/post/:postId', asyncHandler(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 220);
  const details = String(req.body.details || '').trim().slice(0, 1800);
  if (reason.length < 3) return res.status(400).json({ error: 'Describe why you are reporting this post.' });
  const post = await db.query('SELECT employee_id FROM listener_posts WHERE id=$1', [req.params.postId]);
  if (!post.rows[0]) return res.status(404).json({ error: 'Post not found.' });
  const result = await db.query(`
    INSERT INTO reports(reporter_id,target_id,reason,details,priority)
    VALUES($1,$2,$3,$4,'normal') RETURNING id
  `, [req.user.id, post.rows[0].employee_id, `Post ${req.params.postId}: ${reason}`, details || null]);
  res.status(201).json({ report: result.rows[0] });
}));

router.get('/subscriptions', asyncHandler(async (req, res) => {
  await reconcileCustomerSubscriptions(req.user.id);
  await db.query(`
    UPDATE listener_subscriptions
    SET status='expired',updated_at=now()
    WHERE customer_id=$1 AND access_source='razorpay'
      AND status IN ('active','cancelled','completed') AND current_period_end<=now()
  `, [req.user.id]);
  const result = await db.query(`
    SELECT s.id,s.employee_id,s.status,s.current_period_start,s.current_period_end,
           s.cancel_at_cycle_end,s.paid_count,s.access_source,s.grant_note,s.revoked_at,s.created_at,s.updated_at,
           u.name,u.username,u.bio,u.profile_image,u.listener_language,u.listener_availability,
           (SELECT COUNT(*)::int FROM direct_messages m
             WHERE m.subscription_id=s.id AND m.sender_id=s.employee_id AND m.read_at IS NULL) AS unread_count
    FROM listener_subscriptions s
    JOIN users u ON u.id=s.employee_id
    WHERE s.customer_id=$1
      AND (
        s.access_source='admin'
        OR s.paid_count>0
        OR EXISTS(
          SELECT 1 FROM listener_subscription_payments payment
          WHERE payment.subscription_id=s.id AND payment.status='captured'
        )
      )
    ORDER BY CASE
      WHEN s.access_source='admin' AND s.status='active' AND s.revoked_at IS NULL THEN 1
      WHEN s.access_source='razorpay' AND s.status IN ('active','cancelled','completed') AND s.current_period_end>now() THEN 1
      ELSE 0
    END DESC,s.updated_at DESC
  `, [req.user.id]);
  res.json({ subscriptions: result.rows.map((row) => ({
    id: row.id,
    listenerId: row.employee_id,
    listenerName: listenerPublicName(row),
    listenerBio: row.bio,
    listenerImage: profileImageReference(row.profile_image, row.employee_id),
    language: row.listener_language || 'Malayalam',
    availability: row.listener_availability || 'offline',
    status: row.status,
    accessSource: row.access_source,
    active: row.access_source === 'admin'
      ? row.status === 'active' && !row.revoked_at
      : ['active', 'cancelled', 'completed'].includes(row.status) && new Date(row.current_period_end) > new Date(),
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtCycleEnd: Boolean(row.cancel_at_cycle_end),
    paidCount: Number(row.paid_count || 0),
    unreadCount: Number(row.unread_count || 0),
  })) });
}));

router.get('/conversations', asyncHandler(async (req, res) => {
  const result = await db.query(`
    WITH selected_access AS (
      SELECT DISTINCT ON (s.employee_id) s.*
      FROM listener_subscriptions s
      WHERE s.customer_id=$1
        AND NOT EXISTS(
          SELECT 1 FROM customer_blocks block
          WHERE block.customer_id=$1 AND block.employee_id=s.employee_id
        )
        AND (
          s.access_source='admin'
          OR s.paid_count>0
          OR EXISTS(
            SELECT 1 FROM listener_subscription_payments payment
            WHERE payment.subscription_id=s.id AND payment.status='captured'
          )
        )
      ORDER BY s.employee_id,
        CASE
          WHEN s.access_source='admin' AND s.status='active' AND s.revoked_at IS NULL THEN 1
          WHEN s.access_source='razorpay' AND s.status IN ('active','cancelled','completed') AND s.current_period_end>now() THEN 1
          ELSE 0
        END DESC,
        s.updated_at DESC
    )
    SELECT s.id AS subscription_id,s.employee_id,s.status,s.current_period_end,s.access_source,s.revoked_at,
           u.name,u.username,u.profile_image,u.listener_availability,u.listener_language,
           last_message.message,last_message.created_at AS last_message_at,last_message.sender_id,
           COALESCE(unread.count,0)::int AS unread_count
    FROM selected_access s
    JOIN users u ON u.id=s.employee_id
    LEFT JOIN LATERAL (
      SELECT message,created_at,sender_id FROM direct_messages m
      WHERE m.customer_id=$1 AND m.employee_id=s.employee_id ORDER BY created_at DESC LIMIT 1
    ) last_message ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS count FROM direct_messages m
      WHERE m.customer_id=$1 AND m.employee_id=s.employee_id AND m.sender_id=s.employee_id AND m.read_at IS NULL
    ) unread ON true
    ORDER BY COALESCE(last_message.created_at,s.updated_at) DESC
  `, [req.user.id]);
  res.json({ conversations: result.rows.map((row) => ({
    subscriptionId: row.subscription_id,
    listenerId: row.employee_id,
    listenerName: listenerPublicName(row),
    listenerImage: profileImageReference(row.profile_image, row.employee_id),
    availability: row.listener_availability,
    language: row.listener_language || 'Malayalam',
    active: row.access_source === 'admin'
      ? row.status === 'active' && !row.revoked_at
      : ['active', 'cancelled', 'completed'].includes(row.status) && row.current_period_end && new Date(row.current_period_end) > new Date(),
    currentPeriodEnd: row.current_period_end,
    lastMessage: row.message,
    lastMessageAt: row.last_message_at,
    unreadCount: Number(row.unread_count || 0),
  })) });
}));

router.get('/conversations/:employeeId/messages', asyncHandler(async (req, res) => {
  const subscription = await requireActiveSubscription(db, req.user.id, req.params.employeeId);
  const result = await db.query(`
    SELECT id,sender_id,message,read_at,created_at
    FROM direct_messages
    WHERE customer_id=$1 AND employee_id=$2
    ORDER BY created_at ASC LIMIT 500
  `, [req.user.id, req.params.employeeId]);
  await db.query(`
    UPDATE direct_messages SET read_at=now()
    WHERE customer_id=$1 AND employee_id=$2 AND sender_id=$2 AND read_at IS NULL
  `, [req.user.id, req.params.employeeId]);
  res.json({ subscriptionId: subscription.id, messages: result.rows });
}));

router.post('/conversations/:employeeId/messages', asyncHandler(async (req, res) => {
  const content = String(req.body.message || '').trim().slice(0, 2000);
  if (!content) return res.status(400).json({ error: 'Type a message first.' });
  const blocked = await db.query('SELECT 1 FROM customer_blocks WHERE customer_id=$1 AND employee_id=$2', [req.user.id, req.params.employeeId]);
  if (blocked.rows[0]) return res.status(403).json({ error: 'Unblock this listener before sending a message.' });
  const subscription = await requireActiveSubscription(db, req.user.id, req.params.employeeId);
  const result = await db.query(`
    INSERT INTO direct_messages(subscription_id,customer_id,employee_id,sender_id,message)
    VALUES($1,$2,$3,$2,$4)
    RETURNING id,sender_id,message,read_at,created_at
  `, [subscription.id, req.user.id, req.params.employeeId, content]);
  await req.app.locals.notifyUser?.(req.params.employeeId, {
    title: 'New exclusive message',
    body: `${req.user.name}: ${content.slice(0, 120)}`,
    url: './',
    tag: `we-met-message-${result.rows[0].id}`,
  });
  res.status(201).json({ message: result.rows[0] });
}));

router.patch('/profile', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 50) || null;
  const profileImage = normalizeProfileImage(req.body.profileImage);
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (username && !/^[a-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Use 3–50 letters, numbers, dots, underscores or hyphens for the username.' });
  if (profileImage === false) return res.status(400).json({ error: 'Choose a valid JPG, PNG or WebP profile photo.' });
  try {
    const result = await db.query(`
      UPDATE users SET name=$2,username=$3,
        profile_image=CASE WHEN $4::boolean THEN $5 ELSE profile_image END,
        updated_at=now()
      WHERE id=$1 AND role='customer'
      RETURNING id,name,username,profile_image
    `, [req.user.id, name, username, profileImage !== undefined, profileImage === undefined ? null : profileImage]);
    const user = result.rows[0];
    res.json({ user: { id: user.id, name: user.name, username: user.username, profileImage: profileImageReference(user.profile_image, user.id) } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
}));

router.get('/profile/image', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT profile_image FROM users WHERE id=$1 AND role=\'customer\'', [req.user.id]);
  const image = decodeProfileImage(result.rows[0]?.profile_image);
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Content-Length', String(image.buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(image.buffer);
}));

module.exports = router;
