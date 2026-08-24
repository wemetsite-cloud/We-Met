const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const { authenticate, asyncHandler, unavailable, activateExpiredSuspension } = require('../middleware');
const { profileImageReference } = require('../profile-image');
const { normalizePhone, internationalPhone, maskPhone } = require('../phone');
const { sendOtp } = require('../sms');
const createRateLimit = require('../request-limit');

const router = express.Router();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;
const resetAttempts = new Map();
const RESET_WINDOW_MS = 60 * 60 * 1000;
const RESET_LIMIT = 5;
const loginIpLimit = createRateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: 60,
  message: 'Too many sign-in attempts from this connection. Try again later.',
});
const registrationLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many accounts were created from this connection. Try again later.',
});
const recoveryLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  message: 'Too many recovery checks. Try again later.',
});
const otpStartLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: 'Too many OTP requests. Please wait before trying again.',
  key: (req) => `${req.ip}:${String(req.body?.phone || '').replace(/\D/g, '')}`,
});
const otpVerifyLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many OTP checks. Please wait before trying again.',
  key: (req) => `${req.ip}:${String(req.body?.challengeId || '')}`,
});
const loginSupportLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: 'Too many login-support requests. Please wait before trying again.',
  key: (req) => `${req.ip}:${String(req.body?.phone || '').replace(/\D/g, '')}`,
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of loginAttempts) {
    if (now - value.startedAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
  for (const [key, value] of resetAttempts) {
    if (now - value.startedAt > RESET_WINDOW_MS) resetAttempts.delete(key);
  }
}, 15 * 60 * 1000);
cleanupTimer.unref();

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    bio: user.bio,
    profileImage: String(user.profile_image || '').startsWith('photo:') ? user.profile_image : profileImageReference(user.profile_image, user.id),
    bannerImage: String(user.banner_image || '').startsWith('photo:') ? user.banner_image : profileImageReference(user.banner_image, user.id),
    employeeCode: user.employee_code,
    listenerRatePaise: Number(user.listener_rate_paise || 0),
    listenerAvailability: user.listener_availability,
    listenerLanguage: user.listener_language || 'Malayalam',
    listenerVerificationStatus: user.listener_verification_status || 'approved',
    listenerVerificationNote: user.listener_verification_note || null,
    listenerVerifiedAt: user.listener_verified_at || null,
    balanceSeconds: user.balance_seconds,
    status: user.status,
    suspendedUntil: user.suspended_until,
    suspensionReason: user.suspension_reason,
  };
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

function validRecoveryCredentials(requestId, recoveryKey) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    && /^[A-Za-z0-9_-]{32}$/.test(recoveryKey);
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

function otpCodeHash(challengeId, phone, role, code) {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`${challengeId}|${phone}|${role}|${code}`)
    .digest('hex');
}

function registrationTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function safeEqualHex(expected, actual) {
  if (!/^[a-f0-9]{64}$/i.test(String(expected || '')) || !/^[a-f0-9]{64}$/i.test(String(actual || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function validRole(value) {
  return ['customer', 'employee'].includes(value) ? value : null;
}

async function consumeRegistration(client, registrationToken, role) {
  const tokenHash = registrationTokenHash(registrationToken);
  const result = await client.query(`
    SELECT * FROM otp_challenges
    WHERE registration_token_hash=$1 AND role=$2
    FOR UPDATE
  `, [tokenHash, role]);
  const challenge = result.rows[0];
  if (!challenge || !challenge.verified_at || challenge.consumed_at) {
    throw Object.assign(new Error('This phone verification is invalid or was already used.'), { status: 400 });
  }
  if (!challenge.registration_expires_at || new Date(challenge.registration_expires_at) <= new Date()) {
    throw Object.assign(new Error('Phone verification expired. Request a new OTP.'), { status: 410 });
  }
  return challenge;
}

router.post('/phone/start', otpStartLimit, asyncHandler(async (req, res) => {
  const phone = internationalPhone(req.body.phone);
  const role = validRole(String(req.body.role || ''));
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number with country code.' });
  if (!role) return res.status(400).json({ error: 'Choose a valid account type.' });

  const existing = await db.query(
    'SELECT id FROM users WHERE role=$1 AND phone=$2 LIMIT 1',
    [role, phone],
  );
  if (existing.rows[0]) {
    return res.json({ mode: 'password', phone: maskPhone(phone), role });
  }

  const challengeId = crypto.randomUUID();
  const code = !config.sms.enabled && config.sms.testOtp
    ? config.sms.testOtp
    : String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + config.sms.otpExpiryMinutes * 60_000);
  await db.query(`
    INSERT INTO otp_challenges(id,phone,role,code_hash,expires_at)
    VALUES($1,$2,$3,$4,$5)
  `, [challengeId, phone, role, otpCodeHash(challengeId, phone, role, code), expiresAt]);

  try {
    await sendOtp(phone, code, challengeId);
  } catch (error) {
    await db.query('DELETE FROM otp_challenges WHERE id=$1 AND verified_at IS NULL', [challengeId]).catch(() => null);
    throw error;
  }

  return res.status(201).json({
    mode: 'otp',
    challengeId,
    phone: maskPhone(phone),
    expiresInSeconds: config.sms.otpExpiryMinutes * 60,
    developmentOtp: !config.sms.enabled && config.sms.testOtp ? config.sms.testOtp : undefined,
  });
}));

router.post('/support/phone/start', loginSupportLimit, asyncHandler(async (req, res) => {
  const phone = internationalPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number with country code.' });

  const challengeId = crypto.randomUUID();
  const code = !config.sms.enabled && config.sms.testOtp
    ? config.sms.testOtp
    : String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + config.sms.otpExpiryMinutes * 60_000);
  await db.query(`
    INSERT INTO otp_challenges(id,phone,role,code_hash,expires_at)
    VALUES($1,$2,'customer',$3,$4)
  `, [challengeId, phone, otpCodeHash(challengeId, phone, 'customer', code), expiresAt]);

  try {
    await sendOtp(phone, code, `support-${challengeId}`);
  } catch (error) {
    await db.query('DELETE FROM otp_challenges WHERE id=$1 AND verified_at IS NULL', [challengeId]).catch(() => null);
    throw error;
  }

  res.status(201).json({
    challengeId,
    phone: maskPhone(phone),
    expiresInSeconds: config.sms.otpExpiryMinutes * 60,
    developmentOtp: !config.sms.enabled && config.sms.testOtp ? config.sms.testOtp : undefined,
  });
}));

router.post('/phone/verify', otpVerifyLimit, asyncHandler(async (req, res) => {
  const challengeId = String(req.body.challengeId || '').trim();
  const code = String(req.body.otp || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the complete OTP.' });
  }

  const registrationToken = crypto.randomBytes(32).toString('base64url');
  const output = await db.transaction(async (client) => {
    const result = await client.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.consumed_at) throw Object.assign(new Error('OTP request not found.'), { status: 404 });
    if (challenge.verified_at) throw Object.assign(new Error('This OTP was already verified.'), { status: 409 });
    if (new Date(challenge.expires_at) <= new Date()) throw Object.assign(new Error('This OTP expired. Request a new one.'), { status: 410 });
    if (Number(challenge.attempts) >= 5) throw Object.assign(new Error('Too many incorrect attempts. Request a new OTP.'), { status: 429 });

    const expected = otpCodeHash(challenge.id, challenge.phone, challenge.role, code);
    if (!safeEqualHex(expected, challenge.code_hash)) {
      await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
      throw Object.assign(new Error('The OTP is incorrect.'), { status: 400 });
    }

    const registrationExpiresAt = new Date(Date.now() + 15 * 60_000);
    await client.query(`
      UPDATE otp_challenges
      SET verified_at=now(),registration_token_hash=$2,registration_expires_at=$3
      WHERE id=$1
    `, [challenge.id, registrationTokenHash(registrationToken), registrationExpiresAt]);
    return { role: challenge.role, phone: challenge.phone, registrationExpiresAt };
  });

  res.json({
    verified: true,
    role: output.role,
    phone: maskPhone(output.phone),
    registrationToken,
    registrationExpiresAt: output.registrationExpiresAt,
  });
}));

router.post('/phone/register/customer', registrationLimit, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  const termsAccepted = Boolean(req.body.termsAccepted);
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (password.length < 8) return res.status(400).json({ error: 'Create a password with at least 8 characters.' });
  if (!termsAccepted) return res.status(400).json({ error: 'Confirm that you are 18 or older and accept the Terms and Privacy Policy.' });

  try {
    const user = await db.transaction(async (client) => {
      const challenge = await consumeRegistration(client, req.body.registrationToken, 'customer');
      const created = await client.query(`
        INSERT INTO users(role,name,phone,password_hash,terms_accepted_at)
        VALUES('customer',$1,$2,$3,now())
        RETURNING *
      `, [name, challenge.phone, await hashPassword(password)]);
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      return created.rows[0];
    });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A customer account already exists with this phone number.' });
    throw error;
  }
}));

router.post('/phone/register/listener', registrationLimit, asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 50);
  const name = String(req.body.name || '').trim().slice(0, 100);
  const password = String(req.body.password || '');
  const termsAccepted = Boolean(req.body.termsAccepted);
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({ error: 'Use a public username with 3–50 letters, numbers, dots, underscores or hyphens.' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter your original name for private verification.' });
  if (password.length < 8) return res.status(400).json({ error: 'Create a password with at least 8 characters.' });
  if (!termsAccepted) return res.status(400).json({ error: 'Confirm that you are 18 or older and accept the Terms and Privacy Policy.' });

  try {
    const user = await db.transaction(async (client) => {
      const challenge = await consumeRegistration(client, req.body.registrationToken, 'employee');
      const employeeCode = `WM-L${Date.now().toString().slice(-6)}${crypto.randomInt(10, 99)}`;
      const created = await client.query(`
        INSERT INTO users(
          role,name,username,phone,password_hash,terms_accepted_at,employee_code,
          listener_rate_paise,listener_language,listener_verification_status
        ) VALUES('employee',$1,$2,$3,$4,now(),$5,100,'Malayalam','voice_required')
        RETURNING *
      `, [name, username, challenge.phone, await hashPassword(password), employeeCode]);
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      return created.rows[0];
    });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That phone number or public username is already registered.' });
    throw error;
  }
}));

router.post('/support/submit', loginSupportLimit, asyncHandler(async (req, res) => {
  const issue = String(req.body.issue || '').trim().slice(0, 3000);
  if (issue.length < 5) return res.status(400).json({ error: 'Briefly describe the login issue.' });

  const ticket = await db.transaction(async (client) => {
    const challenge = await consumeRegistration(client, req.body.registrationToken, 'customer');
    const created = await client.query(`
      INSERT INTO login_support_tickets(phone,issue)
      VALUES($1,$2)
      RETURNING id,status,created_at
    `, [challenge.phone, issue]);
    await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
    return created.rows[0];
  });

  res.status(201).json({
    ticket,
    message: 'Your login issue was sent securely. The support team can now verify the number and review it.',
  });
}));

router.post('/register', registrationLimit, asyncHandler(async (req, res) => {
  res.status(410).json({
    error: 'Phone verification is required. Start with your mobile number.',
    code: 'PHONE_OTP_REQUIRED',
  });
}));

router.post('/login', loginIpLimit, asyncHandler(async (req, res) => {
  const identifier = String(req.body.identifier || '').trim().toLowerCase();
  const requestedRole = ['customer', 'employee', 'admin'].includes(req.body.role) ? req.body.role : null;
  const phone = normalizePhone(identifier);
  const password = String(req.body.password || '');
  if (!identifier || !password) return res.status(400).json({ error: 'Enter your phone number and password.' });

  const attempt = checkAttempts(req, `${requestedRole || 'any'}:${phone || identifier}`);
  if (attempt.blocked) return res.status(429).json({ error: 'Too many failed attempts. Try again in about 15 minutes.' });

  const result = await db.query(
    `SELECT * FROM users
     WHERE ($1::text IS NULL OR role=$1)
       AND (
         ($2::text IS NOT NULL AND phone=$2)
         OR lower(coalesce(username,''))=$3
         OR lower(coalesce(email,''))=$3
       )
     LIMIT 1`,
    [requestedRole, phone, identifier],
  );
  let user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordFailedAttempt(attempt.key);
    return res.status(401).json({ error: 'The phone number or password is incorrect.' });
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

  await db.query('UPDATE users SET last_login_at=now(),last_seen_at=now(),updated_at=now() WHERE id=$1', [user.id]);
  user.last_login_at = new Date();
  user.last_seen_at = user.last_login_at;

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

  await db.query('UPDATE users SET password_hash=$2,auth_version=auth_version+1,updated_at=now() WHERE id=$1', [req.user.id, await hashPassword(newPassword)]);
  res.json({ ok: true, signedOut: true });
}));

router.post('/change-login', authenticate, asyncHandler(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newUsername = String(req.body.newUsername || '').trim().toLowerCase() || null;
  const result = await db.query('SELECT password_hash,role FROM users WHERE id=$1', [req.user.id]);

  if (!(await verifyPassword(currentPassword, result.rows[0].password_hash))) {
    return res.status(400).json({ error: 'The current password is incorrect.' });
  }

  if (result.rows[0].role !== 'admin') {
    return res.status(410).json({ error: 'Customer and listener accounts use a verified phone number. Email login is not used.' });
  }

  try {
    if (!newUsername || newUsername.length < 3) return res.status(400).json({ error: 'Use an admin username with at least 3 characters.' });
    await db.query('UPDATE users SET username=$2,auth_version=auth_version+1,updated_at=now() WHERE id=$1', [req.user.id, newUsername]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }

  res.json({ ok: true, signedOut: true });
}));

router.post('/change-phone', authenticate, asyncHandler(async (req, res) => {
  res.status(410).json({ error: 'A verified phone number cannot be changed from the profile. Contact support for an identity-safe number change.' });
}));

router.delete('/account', authenticate, asyncHandler(async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'This action is for customer accounts.' });
  const password = String(req.body.password || '');
  const confirmation = String(req.body.confirmation || '').trim().toUpperCase();
  if (confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm permanent account deletion.' });

  const current = await db.query("SELECT password_hash FROM users WHERE id=$1 AND role='customer'", [req.user.id]);
  if (!current.rows[0] || !(await verifyPassword(password, current.rows[0].password_hash))) {
    return res.status(400).json({ error: 'The current password is incorrect.' });
  }

  // End any live browser call before removing the account and its customer records.
  await req.app.locals.socketRuntime?.restrictUser(req.user.id, 'Account deleted.');
  await db.transaction(async (client) => {
    await client.query('DELETE FROM calls WHERE customer_id=$1', [req.user.id]);
    await client.query("DELETE FROM users WHERE id=$1 AND role='customer'", [req.user.id]);
  });

  res.json({ ok: true, message: 'Your We Met customer account has been permanently deleted.' });
}));

router.post('/forgot-password', recoveryLimit, asyncHandler(async (req, res) => {
  const identifier = internationalPhone(req.body.identifier);
  if (!identifier) return res.status(400).json({ error: 'Enter your registered mobile number with country code.' });
  if (!canRequestReset(req, identifier)) {
    return res.status(429).json({ error: 'Too many recovery requests. Try again later.' });
  }

  const result = await db.query(
    `SELECT id FROM users
     WHERE phone=$1 AND role <> 'admin'
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

router.post('/password-reset/status', recoveryLimit, asyncHandler(async (req, res) => {
  const requestId = String(req.body.requestId || '').trim();
  const recoveryKey = String(req.body.recoveryKey || '').trim();
  if (!validRecoveryCredentials(requestId, recoveryKey)) {
    return res.status(400).json({ error: 'Enter the complete recovery request ID and recovery key.' });
  }
  const keyHash = recoveryHash(recoveryKey);
  const result = await db.query(`
    SELECT id,status,admin_message,expires_at,reviewed_at
    FROM password_reset_requests
    WHERE recovery_key_hash=$1 AND id=$2
  `, [keyHash, requestId]);
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

router.post('/password-reset/complete', recoveryLimit, asyncHandler(async (req, res) => {
  const requestId = String(req.body.requestId || '').trim();
  const recoveryKey = String(req.body.recoveryKey || '').trim();
  if (!validRecoveryCredentials(requestId, recoveryKey)) {
    return res.status(400).json({ error: 'Enter the complete recovery request ID and recovery key.' });
  }
  const keyHash = recoveryHash(recoveryKey);
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'Use a new password with at least 8 characters.' });
  const passwordHash = await hashPassword(newPassword);

  const recoveredUserId = await db.transaction(async (client) => {
    const result = await client.query(`
      SELECT id,user_id,status,expires_at
      FROM password_reset_requests
      WHERE recovery_key_hash=$1 AND id=$2
      FOR UPDATE
    `, [keyHash, requestId]);
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
