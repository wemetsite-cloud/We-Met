const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const { authenticate, asyncHandler, unavailable, activateExpiredSuspension } = require('../middleware');

const router = express.Router();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    dateOfBirth: user.date_of_birth,
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

function isAtLeast16(dateString) {
  const dob = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(dob.getTime()) || dob > new Date()) return false;
  const today = new Date();
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const month = today.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 16;
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

router.post('/register', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const dateOfBirth = String(req.body.dateOfBirth || '');
  const termsAccepted = Boolean(req.body.termsAccepted);

  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
  if (!isAtLeast16(dateOfBirth)) return res.status(400).json({ error: 'You must be at least 16 years old to use We Met.' });
  if (!termsAccepted) return res.status(400).json({ error: 'Accept the Terms and Privacy Policy to continue.' });

  try {
    const passwordHash = await hashPassword(password);
    const result = await db.query(
      `INSERT INTO users(role,name,email,date_of_birth,password_hash,terms_accepted_at)
       VALUES('customer',$1,$2,$3,$4,now()) RETURNING *`,
      [name, email, dateOfBirth, passwordHash],
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
  const result = await db.query(
    `SELECT id FROM users
     WHERE lower(coalesce(email,''))=$1 OR lower(coalesce(username,''))=$1
     LIMIT 1`,
    [identifier],
  );
  if (result.rows[0]) {
    await db.query(
      `INSERT INTO password_reset_requests(user_id)
       SELECT $1 WHERE NOT EXISTS(
         SELECT 1 FROM password_reset_requests WHERE user_id=$1 AND status='open'
       )`,
      [result.rows[0].id],
    );
  }
  res.json({ ok: true, message: 'If the account exists, a reset request has been sent to the administrator.' });
}));

module.exports = router;
