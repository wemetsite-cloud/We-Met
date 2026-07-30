const { verifyToken } = require('./auth');
const db = require('./db');

function suspensionExpired(user) {
  return Boolean(
    user?.status === 'suspended'
    && user.suspended_until
    && new Date(user.suspended_until) <= new Date(),
  );
}

function unavailable(user) {
  if (!user) return true;
  if (user.status === 'blocked') return true;
  if (user.status === 'suspended') {
    if (!user.suspended_until) return true;
    return new Date(user.suspended_until) > new Date();
  }
  return false;
}

async function activateExpiredSuspension(user) {
  if (!suspensionExpired(user)) return user;
  await db.query(`
    UPDATE users
    SET status = 'active', suspended_until = NULL, suspension_reason = NULL, updated_at = now()
    WHERE id = $1 AND status = 'suspended'
  `, [user.id]);
  return { ...user, status: 'active', suspended_until: null, suspension_reason: null };
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });

    const payload = verifyToken(token);
    const result = await db.query(
      `SELECT id,role,name,username,email,phone,date_of_birth,bio,employee_code,upi_id,
              balance_seconds,status,suspended_until,suspension_reason,created_at
       FROM users WHERE id=$1`,
      [payload.sub],
    );
    const user = await activateExpiredSuspension(result.rows[0]);
    if (unavailable(user)) return res.status(401).json({ error: 'This account is currently unavailable.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Your login has expired. Please sign in again.' });
  }
}

const requireRole = (...roles) => (req, res, next) => (
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' })
);

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { authenticate, requireRole, asyncHandler, unavailable, suspensionExpired, activateExpiredSuspension };
