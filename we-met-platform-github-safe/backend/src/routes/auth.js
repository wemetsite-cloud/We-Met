const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const { authenticate, asyncHandler, unavailable, activateExpiredSuspension } = require('../middleware');

const router = express.Router();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;
const resetAttempts = new Map();
const RESET_WINDOW_MS = 60 * 60 * 1000;
const RESET_LIMIT = 5;

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    bio: user.bio,
    employeeCode: user.employee_code,
    upiId: user.upi_id,
    balanceSeconds: user.balance_seconds,
    status: user.status,
    suspendedUntil: user.suspended_until,
    suspensionReason: user.suspension_reason,
  };
}

function validEmail(value) {
  return /^\S+@\S+\.\S+$/.test(value);
}

function attemptKey(req, identifier) {
  return `${req.ip}:${identifier}`;
}

function checkAttempts(req, identifier) {
  const key = attemptKey(req, identifier);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 0, startedAt: now });
    return { key, blocked: false };
  }
  return { key, blocked: current.count >= LOGIN_LIMIT };
}

function recordFailedAttempt(key) {
  const current = loginAttempts.get(key) || { count: 0, startedAt: Date.now() };
  current.count += 1;
  loginAttempts.set(key, current);
}

function recoveryHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function canRequestReset(req, identifier) {
  const key = `${req.ip}:${identifier}`;
  const now = Date.now();
  const current = resetAttempts.get(key);
  if (!current || now - current.startedAt > RESET_WINDOW_MS) {
    resetAttempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= RESET_LIMIT) return false;
  current.count += 1;
  return true;
}

router.post('/register', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim().slice(0, 30) || null;
  const password = String(req.body.password || '');
  const termsAccepted = Boolean(req.body.termsAccepted);

  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
  if (!termsAccepted) {
    return res.status(400).json({
      error: 'Confirm that you are at least 18 and accept the Terms and Privacy Policy to continue.',
    });
  }

  try {
    const passwordHash = await hashPassword(password);
    const result = await db.query(
      `INSERT INTO users(role,name,email,phone,password_hash,terms_accepted_at)
       VALUES('customer',$1,$2,$3,$4,now()) RETURNING *`,
      [name, email, phone, passwordHash],
    );
    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account already exists with this email.' });
    throw error;
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!identifier || !password) return res.status(400).json({ error: 'Enter your login and password.' });

  const attempt = checkAttempts(req, identifier);
  if (attempt.blocked) return res.status(429).json({ error: 'Too many failed attempts. Try again in about 15 minutes.' });

  const result = await db.query(
    `SELECT * FROM users
     WHERE lower(coalesce(username,''))=$1 OR lower(coalesce(email,''))=$1
     LIMIT 1`,
    [identifier],
  );
  let user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordFailedAttempt(attempt.key);
    return res.status(401).json({ error: 'The email, username or password is incorrect.' });
  }

  loginAttempts.delete(attempt.key);
  user = await activateExpiredSuspension(user);
  if (unavailable(user)) {
    const until = user.suspended_until ? new Date(user.suspended_until).toLocaleString('en-IN') : '';
    return res.status(403).json({
      error: user.status === 'blocked'
        ? 'This account has been blocked by the administrator.'
        : `This account is suspended${until ? ` until ${until}` : ''}.`,
    });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'The new password must have at least 8 characters.' });

  const result = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await verifyPassword(currentPassword, result.rows[0].password_hash))) {
    return res.status(400).json({ error: 'The current password is incorrect.' });
  }

  await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [req.user.id, await hashPassword(newPassword)]);
  res.json({ ok: true });
}));

router.post('/change-login', authenticate, asyncHandler(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newEmail = String(req.body.newEmail || '').trim().toLowerCase() || null;
  const newUsername = String(req.body.newUsername || '').trim().toLowerCase() || null;
  const result = await db.query('SELECT password_hash,role FROM users WHERE id=$1', [req.user.id]);

  if (!(await verifyPassword(currentPassword, result.rows[0].password_hash))) {
    return res.status(400).json({ error: 'The current password is incorrect.' });
  }

  try {
    if (result.rows[0].role === 'admin') {
      if (!newUsername || newUsername.length < 3) return res.status(400).json({ error: 'Use an admin username with at least 3 characters.' });
      await db.query('UPDATE users SET username=$2,updated_at=now() WHERE id=$1', [req.user.id, newUsername]);
    } else {
      if (!newEmail || !validEmail(newEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
      await db.query('UPDATE users SET email=$2,updated_at=now() WHERE id=$1', [req.user.id, newEmail]);
    }
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That email or username is already in use.' });
    throw error;
  }

  res.json({ ok: true });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier || '').trim().toLowerCase();
  if (!identifier) return res.status(400).json({ error: 'Enter your account email or username.' });
  if (!canRequestReset(req, identifier)) {
    return res.status(429).json({ error: 'Too many recovery requests. Try again later.' });
  }

  const result = await db.query(
    `SELECT id FROM users
     WHERE (lower(coalesce(email,''))=$1 OR lower(coalesce(username,''))=$1)
       AND role <> 'admin'
     LIMIT 1`,
    [identifier],
  );
  const user = result.rows[0];
  if (!user) {
    return res.json({
      ok: true,
      message: 'If the account exists, a recovery request has been sent to the administrator.',
    });
  }

  const recoveryKey = crypto.randomBytes(24).toString('base64url');
  const request = await db.transaction(async (client) => {
    await client.query(`
      UPDATE password_reset_requests
      SET status='declined', admin_message='Replaced by a newer recovery request',
          reviewed_at=now(), resolved_at=now()
      WHERE user_id=$1 AND status IN ('open','approved')
    `, [user.id]);
    const created = await client.query(`
      INSERT INTO password_reset_requests(user_id,recovery_key_hash,expires_at)
      VALUES($1,$2,now()+interval '72 hours')
      RETURNING id,expires_at
    `, [user.id, recoveryHash(recoveryKey)]);
    return created.rows[0];
  });

  res.status(201).json({
    ok: true,
    requestId: request.id,
    recoveryKey,
    expiresAt: request.expires_at,
    message: 'Recovery request sent. Keep this browser open or save the recovery key until the administrator reviews it.',
  });
}));

router.post('/password-reset/status', asyncHandler(async (req, res) => {
  const keyHash = recoveryHash(req.body.recoveryKey);
  const result = await db.query(`
    SELECT id,status,admin_message,expires_at,reviewed_at
    FROM password_reset_requests
    WHERE recovery_key_hash=$1
  `, [keyHash]);
  const request = result.rows[0];
  if (!request) return res.status(404).json({ error: 'Recovery request not found. Check your recovery details.' });

  if (['open', 'approved'].includes(request.status) && new Date(request.expires_at) <= new Date()) {
    await db.query(`
      UPDATE password_reset_requests
      SET status='declined',admin_message='This recovery request expired.',resolved_at=now()
      WHERE id=$1
    `, [request.id]);
    request.status = 'declined';
    request.admin_message = 'This recovery request expired.';
  }

  res.json({
    request: {
      id: request.id,
      status: request.status,
      adminMessage: request.admin_message,
      expiresAt: request.expires_at,
      reviewedAt: request.reviewed_at,
    },
  });
}));

router.post('/password-reset/complete', asyncHandler(async (req, res) => {
  const keyHash = recoveryHash(req.body.recoveryKey);
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'Use a new password with at least 8 characters.' });
  const passwordHash = await hashPassword(newPassword);

  const recoveredUserId = await db.transaction(async (client) => {
    const result = await client.query(`
      SELECT id,user_id,status,expires_at
      FROM password_reset_requests
      WHERE recovery_key_hash=$1
      FOR UPDATE
    `, [keyHash]);
    const request = result.rows[0];
    if (!request) throw Object.assign(new Error('Recovery request not found.'), { status: 404 });
    if (new Date(request.expires_at) <= new Date()) throw Object.assign(new Error('This recovery request has expired.'), { status: 410 });
    if (request.status !== 'approved') {
      throw Object.assign(new Error(request.status === 'open' ? 'The administrator has not approved this request yet.' : 'This recovery request cannot be used.'), { status: 409 });
    }

    await client.query(`
      UPDATE users
      SET password_hash=$2,auth_version=auth_version+1,updated_at=now()
      WHERE id=$1
    `, [request.user_id, passwordHash]);
    await client.query(`
      UPDATE password_reset_requests
      SET status='completed',resolved_at=now()
      WHERE id=$1
    `, [request.id]);
    return request.user_id;
  });

  await req.app.locals.socketRuntime?.restrictUser(recoveredUserId, 'Password changed. Sign in again.');
  res.json({ ok: true, message: 'Password changed. You can now sign in with your new password.' });
}));

module.exports = router;
