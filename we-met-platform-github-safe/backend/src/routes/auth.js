const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const db = require('../db');
const config = require('../config');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const { authenticate, asyncHandler, unavailable, activateExpiredSuspension } = require('../middleware');
const { profileImageReference } = require('../profile-image');
const { normalizePhone, internationalPhone, maskPhone } = require('../phone');
const { sendOtp } = require('../sms');
const createRateLimit = require('../request-limit');

const router = express.Router();
const subscriptionClient = config.razorpay.enabled
  ? new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  : null;
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
const msg91VerifyLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many OTP verification attempts. Please wait before trying again.',
  key: (req) => `${req.ip}:${String(req.body?.phone || '').replace(/\D/g, '')}`,
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

function otpCodeHash(challengeId, phone, role, code, purpose = 'registration') {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`${challengeId}|${phone}|${role}|${purpose}|${code}`)
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


function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function collectPhoneCandidates(value, output = [], depth = 0) {
  if (depth > 6 || value == null) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPhoneCandidates(item, output, depth + 1));
    return output;
  }
  if (typeof value !== 'object') return output;

  // MSG91 has used a few different response/JWT field names across Widget SDK
  // revisions. Keep this deliberately tolerant, but only treat values under a
  // phone/identifier-like key as a phone candidate.
  for (const [key, item] of Object.entries(value)) {
    const compactKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    const isPhoneLikeKey = compactKey.includes('phone')
      || compactKey.includes('mobile')
      || compactKey.includes('identifier');
    if (isPhoneLikeKey && (typeof item === 'string' || typeof item === 'number')) {
      const digits = String(item).replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) output.push(digits);
    }
    if (item && typeof item === 'object') collectPhoneCandidates(item, output, depth + 1);
  }
  return output;
}

function phoneDigitsMatch(expected, candidate) {
  const a = String(expected || '').replace(/\D/g, '');
  const b = String(candidate || '').replace(/\D/g, '');
  if (!a || !b) return false;
  if (a === b) return true;

  // Some MSG91 responses return E.164 digits (country code + national number),
  // while others expose only the national number. A suffix match of at least
  // 8 digits safely handles that representation difference without accepting
  // short/ambiguous values.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return shorter.length >= 8 && longer.endsWith(shorter);
}

function msg91ResponseLooksSuccessful(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.success === false || payload.verified === false || payload.valid === false) return false;
  const negative = [payload.type, payload.status, payload.result].filter((item) => typeof item === 'string').join(' ').toLowerCase();
  if (/error|fail|invalid|unauthor|forbidden|expired/.test(negative)) return false;
  const message = String(payload.message || payload.error || '').toLowerCase();
  if (/invalid|expired|unauthor|forbidden|failed|failure|error/.test(message) && !/success/.test(message)) return false;
  return true;
}

async function verifyMsg91AccessToken(accessToken, phone) {
  if (!config.msg91.authKey) {
    throw Object.assign(new Error('MSG91 server verification is not configured. Add MSG91_AUTH_KEY on Render.'), { status: 503 });
  }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw Object.assign(new Error('OTP verification token is invalid. Request a new OTP.'), { status: 400 });
  }

  let response;
  try {
    response = await fetch(config.msg91.verifyAccessTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ authkey: config.msg91.authKey, 'access-token': accessToken }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error('MSG91 access-token verification network error:', error?.message || error);
    throw Object.assign(new Error('MSG91 verification is temporarily unavailable. Please try again.'), { status: 502 });
  }

  let payload = null;
  try { payload = await response.json(); } catch (_error) { payload = null; }
  if (!response.ok || !msg91ResponseLooksSuccessful(payload)) {
    console.error('MSG91 access-token verification rejected:', response.status, payload);
    throw Object.assign(new Error('MSG91 could not verify this OTP session. Request a new OTP.'), { status: 400 });
  }

  const expectedDigits = String(phone).replace(/\D/g, '');
  const candidates = [...new Set([
    ...collectPhoneCandidates(payload),
    ...collectPhoneCandidates(decodeJwtPayload(accessToken)),
  ])];

  // The verifyAccessToken endpoint is the source of truth that the OTP was
  // successfully verified. When MSG91 includes the identifier in its response
  // (or JWT), bind it to the requested phone and reject a real mismatch. Some
  // Widget responses only return verification status and no identifier at all;
  // treating that absence as a mismatch caused valid OTPs to fail on We Met.
  if (candidates.length && !candidates.some((digits) => phoneDigitsMatch(expectedDigits, digits))) {
    console.error('MSG91 verified token identifier did not match requested phone.', {
      expectedLast4: expectedDigits.slice(-4),
      candidateLast4: candidates.map((v) => v.slice(-4)),
    });
    throw Object.assign(new Error('The verified OTP belongs to a different mobile number. Request a new OTP.'), { status: 400 });
  }
  if (!candidates.length) {
    console.info('MSG91 access token verified; provider response did not expose a phone identifier.');
  }
  return payload;
}

async function createVerifiedProviderChallenge({ phone, role, purpose, accessToken }) {
  const oneTimeToken = crypto.randomBytes(32).toString('base64url');
  const challengeId = crypto.randomUUID();
  const providerHash = crypto.createHash('sha256').update(`msg91|${accessToken}`).digest('hex');
  const tokenExpiresAt = new Date(Date.now() + 15 * 60_000);
  const otpExpiresAt = new Date(Date.now() + 15 * 60_000);
  await db.transaction(async (client) => {
    const replay = await client.query(
      'SELECT id FROM otp_challenges WHERE code_hash=$1 AND verified_at IS NOT NULL LIMIT 1 FOR UPDATE',
      [providerHash],
    );
    if (replay.rows[0]) throw Object.assign(new Error('This OTP verification was already used. Request a new OTP.'), { status: 409 });
    await client.query(`
      INSERT INTO otp_challenges(id,phone,role,purpose,code_hash,expires_at,verified_at,registration_token_hash,registration_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8)
    `, [challengeId, phone, role, purpose, providerHash, otpExpiresAt, registrationTokenHash(oneTimeToken), tokenExpiresAt]);
  });
  return { oneTimeToken, tokenExpiresAt };
}

async function consumeRegistration(client, registrationToken, role, purpose = 'registration', options = {}) {
  const tokenHash = registrationTokenHash(registrationToken);
  const result = await client.query(`
    SELECT * FROM otp_challenges
    WHERE registration_token_hash=$1 AND role=$2 AND purpose=$3
    FOR UPDATE
  `, [tokenHash, role, purpose]);
  const challenge = result.rows[0];
  if (!challenge || !challenge.verified_at) {
    throw Object.assign(new Error('This phone verification is invalid. Request a new OTP.'), { status: 400 });
  }
  if (!challenge.registration_expires_at || new Date(challenge.registration_expires_at) <= new Date()) {
    throw Object.assign(new Error('Phone verification expired. Request a new OTP.'), { status: 410 });
  }
  // Registration submits can be repeated by browsers after a slow network response.
  // Allow the route to inspect a consumed challenge and return the account that was
  // already created from this exact secret token instead of falsely telling the user
  // that a correct OTP failed. Other purposes remain strictly one-time.
  if (challenge.consumed_at && !options.allowConsumed) {
    throw Object.assign(new Error('This phone verification was already used.'), { status: 400 });
  }
  return challenge;
}

async function createOtpChallenge({ phone, role, purpose, reference = '' }) {
  const challengeId = crypto.randomUUID();
  const code = !config.sms.enabled && config.sms.testOtp
    ? config.sms.testOtp
    : String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + config.sms.otpExpiryMinutes * 60_000);
  await db.query(`
    INSERT INTO otp_challenges(id,phone,role,purpose,code_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [challengeId, phone, role, purpose, otpCodeHash(challengeId, phone, role, code, purpose), expiresAt]);

  try {
    await sendOtp(phone, code, reference || `${purpose}-${challengeId}`);
  } catch (error) {
    await db.query('DELETE FROM otp_challenges WHERE id=$1 AND verified_at IS NULL', [challengeId]).catch(() => null);
    throw error;
  }

  return {
    challengeId,
    phone: maskPhone(phone),
    expiresInSeconds: config.sms.otpExpiryMinutes * 60,
    developmentOtp: !config.sms.enabled && config.sms.testOtp ? config.sms.testOtp : undefined,
  };
}

router.post('/phone/start', otpStartLimit, asyncHandler(async (req, res) => {
  const phone = internationalPhone(req.body.phone);
  const role = validRole(String(req.body.role || ''));
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number with country code.' });
  if (!role) return res.status(400).json({ error: 'Choose a valid account type.' });

  const existing = await db.query('SELECT id FROM users WHERE role=$1 AND phone=$2 LIMIT 1', [role, phone]);
  if (existing.rows[0]) return res.json({ mode: 'password', phone: maskPhone(phone), role });

  // Registration OTP is sent and verified by the MSG91 Web SDK in the browser.
  return res.json({ mode: 'otp', phone: maskPhone(phone), role, provider: 'msg91' });
}));

router.post('/phone/login/start', (_req, res) => {
  res.status(410).json({ error: 'Existing accounts use password login. Use Forgot password if you cannot remember it.' });
});

router.post('/msg91/verify', msg91VerifyLimit, asyncHandler(async (req, res) => {
  const phone = internationalPhone(req.body.phone);
  const role = validRole(String(req.body.role || ''));
  const purpose = ['registration', 'password_reset'].includes(String(req.body.purpose || '')) ? String(req.body.purpose) : null;
  const accessToken = String(req.body.accessToken || '').trim();
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number with country code.' });
  if (!role || !purpose) return res.status(400).json({ error: 'OTP verification request is invalid.' });
  if (!accessToken) return res.status(400).json({ error: 'Verify the OTP again.' });

  const found = await db.query('SELECT id FROM users WHERE role=$1 AND phone=$2 LIMIT 1', [role, phone]);
  if (purpose === 'registration' && found.rows[0]) {
    return res.status(409).json({ error: 'An account already exists with this mobile number. Sign in with your password.' });
  }
  if (purpose === 'password_reset' && !found.rows[0]) {
    return res.status(404).json({ error: 'No account was found with this mobile number.' });
  }

  await verifyMsg91AccessToken(accessToken, phone);
  const verified = await createVerifiedProviderChallenge({ phone, role, purpose, accessToken });
  const response = {
    verified: true,
    role,
    phone: maskPhone(phone),
    tokenExpiresAt: verified.tokenExpiresAt,
  };
  if (purpose === 'password_reset') response.resetToken = verified.oneTimeToken;
  else response.registrationToken = verified.oneTimeToken;
  return res.json(response);
}));

router.post('/support/phone/start', loginSupportLimit, asyncHandler(async (req, res) => {
  const phone = internationalPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number with country code.' });

  res.status(201).json(await createOtpChallenge({ phone, role: 'customer', purpose: 'support' }));
}));

router.post('/phone/verify', otpVerifyLimit, asyncHandler(async (req, res) => {
  const challengeId = String(req.body.challengeId || '').trim();
  const code = String(req.body.otp || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the complete OTP.' });
  }

  const oneTimeToken = crypto.randomBytes(32).toString('base64url');
  const output = await db.transaction(async (client) => {
    const result = await client.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.consumed_at) throw Object.assign(new Error('OTP request not found.'), { status: 404 });
    if (challenge.verified_at) throw Object.assign(new Error('This OTP was already verified.'), { status: 409 });
    if (new Date(challenge.expires_at) <= new Date()) throw Object.assign(new Error('This OTP expired. Request a new one.'), { status: 410 });
    if (Number(challenge.attempts) >= 5) throw Object.assign(new Error('Too many incorrect attempts. Request a new OTP.'), { status: 429 });

    const expected = otpCodeHash(challenge.id, challenge.phone, challenge.role, code, challenge.purpose);
    if (!safeEqualHex(expected, challenge.code_hash)) {
      await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
      throw Object.assign(new Error('The OTP is incorrect.'), { status: 400 });
    }

    if (challenge.purpose === 'login') {
      await client.query('UPDATE otp_challenges SET verified_at=now(),consumed_at=now() WHERE id=$1', [challenge.id]);
      return { role: challenge.role, phone: challenge.phone, purpose: challenge.purpose };
    }

    const tokenExpiresAt = new Date(Date.now() + 15 * 60_000);
    await client.query(`
      UPDATE otp_challenges
      SET verified_at=now(),registration_token_hash=$2,registration_expires_at=$3
      WHERE id=$1
    `, [challenge.id, registrationTokenHash(oneTimeToken), tokenExpiresAt]);
    return { role: challenge.role, phone: challenge.phone, purpose: challenge.purpose, tokenExpiresAt };
  });

  if (output.purpose === 'login') {
    const found = await db.query('SELECT * FROM users WHERE role=$1 AND phone=$2 LIMIT 1', [output.role, output.phone]);
    let user = found.rows[0];
    if (!user) return res.status(404).json({ error: 'This account no longer exists.' });
    user = await activateExpiredSuspension(user);
    if (unavailable(user)) {
      return res.status(403).json({ error: user.status === 'blocked' ? 'This account has been blocked by the administrator.' : 'This account is currently suspended.' });
    }
    await db.query('UPDATE users SET last_login_at=now(),last_seen_at=now(),updated_at=now() WHERE id=$1', [user.id]);
    return res.json({ verified: true, mode: 'login', token: signToken(user), user: publicUser(user) });
  }

  const response = {
    verified: true,
    role: output.role,
    phone: maskPhone(output.phone),
    tokenExpiresAt: output.tokenExpiresAt,
  };
  if (output.purpose === 'password_reset') response.resetToken = oneTimeToken;
  else response.registrationToken = oneTimeToken;
  return res.json(response);
}));

router.post('/phone/register/customer', registrationLimit, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  const termsAccepted = Boolean(req.body.termsAccepted);
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (password.length < 8) return res.status(400).json({ error: 'Create a password with at least 8 characters.' });
  if (!termsAccepted) return res.status(400).json({ error: 'Confirm that you are 18 or older and accept the Terms and Privacy Policy.' });

  try {
    const result = await db.transaction(async (client) => {
      const challenge = await consumeRegistration(client, req.body.registrationToken, 'customer', 'registration', { allowConsumed: true });
      if (challenge.consumed_at) {
        const existing = await client.query(`SELECT * FROM users WHERE role='customer' AND phone=$1 LIMIT 1`, [challenge.phone]);
        if (!existing.rows[0]) throw Object.assign(new Error('This phone verification was already used. Request a new OTP.'), { status: 400 });
        return { user: existing.rows[0], created: false };
      }
      const existing = await client.query(`SELECT id FROM users WHERE role='customer' AND phone=$1 LIMIT 1 FOR UPDATE`, [challenge.phone]);
      if (existing.rows[0]) throw Object.assign(new Error('A customer account already exists with this phone number. Sign in with your password.'), { status: 409 });
      const created = await client.query(`
        INSERT INTO users(role,name,phone,password_hash,terms_accepted_at)
        VALUES('customer',$1,$2,$3,now())
        RETURNING *
      `, [name, challenge.phone, await hashPassword(password)]);
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      return { user: created.rows[0], created: true };
    });
    res.status(result.created ? 201 : 200).json({ token: signToken(result.user), user: publicUser(result.user), resumed: !result.created });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A customer account already exists with this phone number. Sign in with your password.' });
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
    const result = await db.transaction(async (client) => {
      const challenge = await consumeRegistration(client, req.body.registrationToken, 'employee', 'registration', { allowConsumed: true });
      if (challenge.consumed_at) {
        const existing = await client.query(`SELECT * FROM users WHERE role='employee' AND phone=$1 LIMIT 1`, [challenge.phone]);
        if (!existing.rows[0]) throw Object.assign(new Error('This phone verification was already used. Request a new OTP.'), { status: 400 });
        return { user: existing.rows[0], created: false };
      }
      const phoneOwner = await client.query(`SELECT id FROM users WHERE role='employee' AND phone=$1 LIMIT 1 FOR UPDATE`, [challenge.phone]);
      if (phoneOwner.rows[0]) throw Object.assign(new Error('A listener account already exists with this phone number. Sign in with your password.'), { status: 409 });
      const employeeCode = `WM-L${Date.now().toString().slice(-6)}${crypto.randomInt(10, 99)}`;
      const created = await client.query(`
        INSERT INTO users(
          role,name,username,phone,password_hash,terms_accepted_at,employee_code,
          listener_rate_paise,listener_language,listener_verification_status
        ) VALUES('employee',$1,$2,$3,$4,now(),$5,100,'Malayalam','voice_required')
        RETURNING *
      `, [name, username, challenge.phone, await hashPassword(password), employeeCode]);
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      return { user: created.rows[0], created: true };
    });
    res.status(result.created ? 201 : 200).json({ token: signToken(result.user), user: publicUser(result.user), resumed: !result.created });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That phone number or public username is already registered.' });
    throw error;
  }
}));

router.post('/support/submit', loginSupportLimit, asyncHandler(async (req, res) => {
  const issue = String(req.body.issue || '').trim().slice(0, 3000);
  if (issue.length < 5) return res.status(400).json({ error: 'Briefly describe the login issue.' });

  const ticket = await db.transaction(async (client) => {
    const challenge = await consumeRegistration(client, req.body.registrationToken, 'customer', 'support');
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

  const recurring = await db.query(`
    SELECT razorpay_subscription_id
    FROM listener_subscriptions
    WHERE customer_id=$1 AND status IN ('created','authenticated','active','paused','halted','pending')
  `, [req.user.id]);
  if (recurring.rows.length && !subscriptionClient) {
    return res.status(503).json({ error: 'Recurring memberships could not be cancelled because Razorpay is not configured. Contact support before deleting this account.' });
  }
  for (const item of recurring.rows) {
    try {
      await subscriptionClient.subscriptions.cancel(item.razorpay_subscription_id, { cancel_at_cycle_end: 0 });
    } catch (error) {
      const providerStatus = String(error?.error?.description || error?.message || '');
      if (!/already|cancelled|completed|expired/i.test(providerStatus)) {
        console.error('Account deletion subscription cancellation failed:', error?.error?.code || error?.message || error);
        return res.status(502).json({ error: 'A recurring membership could not be cancelled. No account data was deleted; please try again or contact support.' });
      }
    }
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
  const phone = internationalPhone(req.body.identifier || req.body.phone);
  const role = validRole(String(req.body.role || ''));
  if (!phone) return res.status(400).json({ error: 'Enter your registered mobile number with country code.' });
  if (!role) return res.status(400).json({ error: 'Choose a valid account type.' });
  if (!canRequestReset(req, `${role}:${phone}`)) return res.status(429).json({ error: 'Too many recovery requests. Try again later.' });

  const found = await db.query('SELECT id FROM users WHERE phone=$1 AND role=$2 LIMIT 1', [phone, role]);
  if (!found.rows[0]) return res.status(404).json({ error: 'No account was found with this mobile number.' });
  return res.json({ ok: true, mode: 'otp', provider: 'msg91', phone: maskPhone(phone), message: 'Send an OTP to continue.' });
}));

router.post('/password-reset/status', recoveryLimit, asyncHandler(async (req, res) => {
  res.status(410).json({ error: 'Administrator approval is no longer used. Request a new SMS OTP from the sign-in screen.' });
}));

router.post('/password-reset/complete', recoveryLimit, asyncHandler(async (req, res) => {
  const resetToken = String(req.body.resetToken || '').trim();
  const role = validRole(String(req.body.role || ''));
  const newPassword = String(req.body.newPassword || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(resetToken)) return res.status(400).json({ error: 'Verify the SMS OTP again.' });
  if (!role) return res.status(400).json({ error: 'Choose a valid account type.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Use a new password with at least 8 characters.' });
  const passwordHash = await hashPassword(newPassword);
  const tokenHash = registrationTokenHash(resetToken);

  const recoveredUserId = await db.transaction(async (client) => {
    const result = await client.query(`
      SELECT id,phone,role,verified_at,registration_expires_at,consumed_at
      FROM otp_challenges
      WHERE registration_token_hash=$1 AND purpose='password_reset' AND role=$2
      FOR UPDATE
    `, [tokenHash, role]);
    const challenge = result.rows[0];
    if (!challenge || !challenge.verified_at || challenge.consumed_at) throw Object.assign(new Error('This reset verification is invalid or was already used.'), { status: 400 });
    if (!challenge.registration_expires_at || new Date(challenge.registration_expires_at) <= new Date()) throw Object.assign(new Error('This reset verification expired. Request a new OTP.'), { status: 410 });

    const found = await client.query('SELECT id FROM users WHERE phone=$1 AND role=$2 FOR UPDATE', [challenge.phone, challenge.role]);
    const user = found.rows[0];
    if (!user) throw Object.assign(new Error('This account no longer exists.'), { status: 404 });

    await client.query(`
      UPDATE users
      SET password_hash=$2,auth_version=auth_version+1,updated_at=now()
      WHERE id=$1
    `, [user.id, passwordHash]);
    await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
    return user.id;
  });

  await req.app.locals.socketRuntime?.restrictUser(recoveredUserId, 'Password changed. Sign in again.');
  res.json({ ok: true, message: 'Password changed. You can now sign in with your new password.' });
}));

module.exports = router;
