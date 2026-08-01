const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');

const scryptAsync = promisify(crypto.scrypt);

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algorithm, saltHex, hashHex] = String(stored).split('$');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_error) {
    return false;
  }
}

function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: user.id,
    role: user.role,
    name: user.name,
    ver: Number(user.auth_version || 0),
    iss: config.appName,
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
  }));
  const signature = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const [header, payload, signature] = String(token || '').split('.');
  if (!header || !payload || !signature) throw new Error('Malformed token');
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  const valid = expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!valid) throw new Error('Invalid token');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (decoded.iss !== config.appName || decoded.exp < Math.floor(Date.now() / 1000)) throw new Error('Expired token');
  return decoded;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
