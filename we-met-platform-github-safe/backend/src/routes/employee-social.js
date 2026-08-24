'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { authenticate, requireRole, asyncHandler } = require('../middleware');
const { decodeProfileImage, profileImageReference } = require('../profile-image');
const { requireActiveSubscription } = require('../subscription-access');

const router = express.Router();
router.use(authenticate, requireRole('employee'));

function fileSignatureMatches(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'audio/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'audio/ogg') return buffer.subarray(0, 4).toString() === 'OggS';
  if (mime === 'audio/mp4') return buffer.subarray(4, 8).toString() === 'ftyp';
  if (mime === 'audio/mpeg') return buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE';
  return false;
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const accepted = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];
    const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
    if (!accepted.includes(mime)) {
      return callback(Object.assign(new Error('Record or upload a WebM, OGG, MP4, MP3 or WAV voice clip.'), { status: 400 }));
    }
    file.mimetype = mime;
    return callback(null, true);
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      return callback(Object.assign(new Error('Choose a JPG, PNG or WebP photo.'), { status: 400 }));
    }
    file.mimetype = mime;
    return callback(null, true);
  },
});

router.get('/verification', asyncHandler(async (req, res) => {
  const [setting, user, latest] = await Promise.all([
    db.query("SELECT value,updated_at FROM platform_settings WHERE key='listener_verification_prompt'"),
    db.query(`
      SELECT listener_verification_status,listener_verification_note,listener_verified_at
      FROM users WHERE id=$1 AND role='employee'
    `, [req.user.id]),
    db.query(`
      SELECT id,prompt_text,audio_mime,audio_size,status,admin_note,reviewed_at,created_at
      FROM listener_verifications WHERE employee_id=$1
      ORDER BY created_at DESC LIMIT 1
    `, [req.user.id]),
  ]);
  const current = user.rows[0];
  res.json({
    status: current?.listener_verification_status || 'voice_required',
    note: current?.listener_verification_note || null,
    verifiedAt: current?.listener_verified_at || null,
    prompt: setting.rows[0]?.value || 'ഞാൻ വി മെറ്റിൽ ആദരവോടെയും ഉത്തരവാദിത്തത്തോടെയും സംസാരിക്കും.',
    submission: latest.rows[0] || null,
  });
}));

router.post('/verification/audio', audioUpload.single('audio'), asyncHandler(async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Record the Malayalam line before submitting.' });
  if (!fileSignatureMatches(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'The voice recording format could not be verified.' });
  const current = await db.query(`
    SELECT listener_verification_status FROM users WHERE id=$1 AND role='employee'
  `, [req.user.id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'Listener account not found.' });
  if (current.rows[0].listener_verification_status === 'approved') {
    return res.status(409).json({ error: 'This listener account is already verified.' });
  }
  const prompt = await db.query("SELECT value FROM platform_settings WHERE key='listener_verification_prompt'");
  const promptText = prompt.rows[0]?.value || 'ഞാൻ വി മെറ്റിൽ ആദരവോടെയും ഉത്തരവാദിത്തത്തോടെയും സംസാരിക്കും.';

  const submission = await db.transaction(async (client) => {
    await client.query(`
      UPDATE listener_verifications
      SET status='rejected',admin_note='Replaced by a newer recording.',updated_at=now()
      WHERE employee_id=$1 AND status='pending'
    `, [req.user.id]);
    const result = await client.query(`
      INSERT INTO listener_verifications(
        employee_id,prompt_text,audio_mime,audio_size,audio_data
      ) VALUES($1,$2,$3,$4,$5)
      RETURNING id,status,created_at
    `, [req.user.id, promptText, req.file.mimetype, req.file.size, req.file.buffer]);
    await client.query(`
      UPDATE users
      SET listener_verification_status='pending',listener_verification_note=NULL,
          listener_availability='offline',updated_at=now()
      WHERE id=$1
    `, [req.user.id]);
    return result.rows[0];
  });
  await req.app.locals.socketRuntime?.refreshEmployeeProfile?.(req.user.id);
  res.status(201).json({ submission, message: 'Recording submitted. The administrator will review it.' });
}));

router.get('/verification/audio/:id', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT audio_mime,audio_size,audio_data
    FROM listener_verifications WHERE id=$1 AND employee_id=$2
  `, [req.params.id, req.user.id]);
  const audio = result.rows[0];
  if (!audio) return res.status(404).end();
  res.setHeader('Content-Type', audio.audio_mime);
  res.setHeader('Content-Length', String(audio.audio_size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(audio.audio_data);
}));

router.get('/posts', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT id,caption,image_mime,image_size,created_at,updated_at
    FROM listener_posts WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 100
  `, [req.user.id]);
  res.json({ posts: result.rows.map((post) => ({ ...post, imageUrl: `/api/employee/posts/${post.id}/image` })) });
}));

router.post('/posts', imageUpload.single('photo'), asyncHandler(async (req, res) => {
  if (req.user.listener_verification_status !== 'approved') {
    return res.status(403).json({ error: 'Complete listener verification before publishing photos.' });
  }
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Choose a photo to publish.' });
  if (!fileSignatureMatches(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'The photo format could not be verified.' });
  const caption = String(req.body.caption || '').trim().slice(0, 1000) || null;
  const result = await db.query(`
    INSERT INTO listener_posts(employee_id,image_mime,image_size,image_data,caption)
    VALUES($1,$2,$3,$4,$5)
    RETURNING id,caption,image_mime,image_size,created_at
  `, [req.user.id, req.file.mimetype, req.file.size, req.file.buffer, caption]);
  res.status(201).json({ post: { ...result.rows[0], imageUrl: `/api/employee/posts/${result.rows[0].id}/image` } });
}));

router.get('/posts/:id/image', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT image_mime,image_size,image_data
    FROM listener_posts WHERE id=$1 AND employee_id=$2
  `, [req.params.id, req.user.id]);
  const image = result.rows[0];
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.image_mime);
  res.setHeader('Content-Length', String(image.image_size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(image.image_data);
}));

router.delete('/posts/:id', asyncHandler(async (req, res) => {
  const result = await db.query('DELETE FROM listener_posts WHERE id=$1 AND employee_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Photo not found.' });
  res.json({ ok: true });
}));

router.get('/followers', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT f.customer_id,f.created_at,u.name,u.username,u.profile_image,
           EXISTS(
             SELECT 1 FROM listener_subscriptions s
             WHERE s.customer_id=f.customer_id AND s.employee_id=f.employee_id
               AND s.status='active' AND s.current_period_end>now()
               AND (
                 s.paid_count>0
                 OR EXISTS(
                   SELECT 1 FROM listener_subscription_payments payment
                   WHERE payment.subscription_id=s.id AND payment.status='captured'
                 )
               )
           ) AS subscribed
    FROM listener_follows f
    JOIN users u ON u.id=f.customer_id AND u.role='customer'
    WHERE f.employee_id=$1
    ORDER BY f.created_at DESC LIMIT 500
  `, [req.user.id]);
  res.json({
    count: result.rows.length,
    followers: result.rows.map((row) => ({
      customerId: row.customer_id,
      name: row.username || row.name,
      profileImage: profileImageReference(row.profile_image, row.customer_id),
      followedAt: row.created_at,
      subscribed: Boolean(row.subscribed),
    })),
  });
}));

router.get('/followers/:customerId/image', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT u.profile_image
    FROM listener_follows f
    JOIN users u ON u.id=f.customer_id
    WHERE f.employee_id=$1 AND f.customer_id=$2
  `, [req.user.id, req.params.customerId]);
  const image = decodeProfileImage(result.rows[0]?.profile_image);
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Content-Length', String(image.buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(image.buffer);
}));

router.get('/inbox', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT DISTINCT ON (s.customer_id)
           s.customer_id,s.status,s.current_period_end,u.name,u.username,u.profile_image,
           last_message.message,last_message.created_at AS last_message_at,last_message.sender_id,
           COALESCE(unread.count,0)::int AS unread_count
    FROM listener_subscriptions s
    JOIN users u ON u.id=s.customer_id
    LEFT JOIN LATERAL (
      SELECT message,created_at,sender_id FROM direct_messages m
      WHERE m.customer_id=s.customer_id AND m.employee_id=s.employee_id
      ORDER BY created_at DESC LIMIT 1
    ) last_message ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS count FROM direct_messages m
      WHERE m.customer_id=s.customer_id AND m.employee_id=s.employee_id
        AND m.sender_id=s.customer_id AND m.read_at IS NULL
    ) unread ON true
    WHERE s.employee_id=$1
      AND (
        s.paid_count>0
        OR EXISTS(
          SELECT 1 FROM listener_subscription_payments payment
          WHERE payment.subscription_id=s.id AND payment.status='captured'
        )
      )
    ORDER BY s.customer_id,s.updated_at DESC
  `, [req.user.id]);
  res.json({ conversations: result.rows.map((row) => ({
    customerId: row.customer_id,
    customerName: row.username || row.name,
    customerImage: profileImageReference(row.profile_image, row.customer_id),
    active: row.status === 'active' && row.current_period_end && new Date(row.current_period_end) > new Date(),
    currentPeriodEnd: row.current_period_end,
    lastMessage: row.message,
    lastMessageAt: row.last_message_at,
    unreadCount: Number(row.unread_count || 0),
  })) });
}));

router.get('/inbox/:customerId/messages', asyncHandler(async (req, res) => {
  const relation = await db.query(`
    SELECT 1 FROM listener_subscriptions subscription
    WHERE customer_id=$1 AND employee_id=$2
      AND (
        paid_count>0
        OR EXISTS(
          SELECT 1 FROM listener_subscription_payments payment
          WHERE payment.subscription_id=subscription.id AND payment.status='captured'
        )
      )
    LIMIT 1
  `, [req.params.customerId, req.user.id]);
  if (!relation.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
  const result = await db.query(`
    SELECT id,sender_id,message,read_at,created_at
    FROM direct_messages
    WHERE customer_id=$1 AND employee_id=$2
    ORDER BY created_at ASC LIMIT 500
  `, [req.params.customerId, req.user.id]);
  await db.query(`
    UPDATE direct_messages SET read_at=now()
    WHERE customer_id=$1 AND employee_id=$2 AND sender_id=$1 AND read_at IS NULL
  `, [req.params.customerId, req.user.id]);
  const subscription = await db.query(`
    SELECT status,current_period_end FROM listener_subscriptions
    WHERE customer_id=$1 AND employee_id=$2
    ORDER BY updated_at DESC LIMIT 1
  `, [req.params.customerId, req.user.id]);
  const latest = subscription.rows[0];
  res.json({
    active: latest?.status === 'active' && latest.current_period_end && new Date(latest.current_period_end) > new Date(),
    messages: result.rows,
  });
}));

router.get('/inbox/:customerId/image', asyncHandler(async (req, res) => {
  const result = await db.query(`
    SELECT u.profile_image
    FROM listener_subscriptions subscription
    JOIN users u ON u.id=subscription.customer_id AND u.role='customer'
    WHERE subscription.employee_id=$1 AND subscription.customer_id=$2
      AND (
        subscription.paid_count>0
        OR EXISTS(
          SELECT 1 FROM listener_subscription_payments payment
          WHERE payment.subscription_id=subscription.id AND payment.status='captured'
        )
      )
    LIMIT 1
  `, [req.user.id, req.params.customerId]);
  const image = decodeProfileImage(result.rows[0]?.profile_image);
  if (!image) return res.status(404).end();
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Content-Length', String(image.buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(image.buffer);
}));

router.post('/inbox/:customerId/messages', asyncHandler(async (req, res) => {
  const content = String(req.body.message || '').trim().slice(0, 2000);
  if (!content) return res.status(400).json({ error: 'Type a message first.' });
  const subscription = await requireActiveSubscription(db, req.params.customerId, req.user.id);
  const result = await db.query(`
    INSERT INTO direct_messages(subscription_id,customer_id,employee_id,sender_id,message)
    VALUES($1,$2,$3,$3,$4)
    RETURNING id,sender_id,message,read_at,created_at
  `, [subscription.id, req.params.customerId, req.user.id, content]);
  await req.app.locals.notifyUser?.(req.params.customerId, {
    title: 'New message from your listener',
    body: content.slice(0, 140),
    url: './',
    tag: `we-met-message-${result.rows[0].id}`,
  });
  res.status(201).json({ message: result.rows[0] });
}));

module.exports = router;
