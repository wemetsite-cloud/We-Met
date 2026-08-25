const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { hashPassword } = require('../src/auth');
const config = require('../src/config');
const { normalizePhone } = require('../src/phone');
const { settleCall } = require('../src/call-settlement');

async function upsertAdmin() {
  const passwordHash = await hashPassword(config.admin.password);
  await pool.query(`
    INSERT INTO users(role,name,username,password_hash)
    VALUES('admin',$1,$2,$3)
    ON CONFLICT(username) DO UPDATE SET
      name=EXCLUDED.name,
      role='admin',
      password_hash=CASE WHEN $4 THEN EXCLUDED.password_hash ELSE users.password_hash END,
      updated_at=now()
  `, [config.admin.name, config.admin.username.toLowerCase(), passwordHash, config.resetSeededPasswords]);
}

async function upsertInitialListener() {
  const listener = config.initialListener;
  if (!listener.phone || !listener.password) return false;

  const passwordHash = await hashPassword(listener.password);
  const phone = normalizePhone(listener.phone);
  try {
    await pool.query(`
    INSERT INTO users(role,name,username,phone,employee_code,password_hash,bio,listener_language,listener_rate_paise,listener_verification_status,listener_verified_at)
    VALUES('employee',$1,$2,$3,$4,$5,$6,'Malayalam',100,'approved',now())
    ON CONFLICT(username) DO UPDATE SET
      name=EXCLUDED.name,
      phone=EXCLUDED.phone,
      employee_code=EXCLUDED.employee_code,
      role='employee',
      listener_verification_status='approved',
      listener_verified_at=COALESCE(users.listener_verified_at,now()),
      password_hash=CASE WHEN $7 THEN EXCLUDED.password_hash ELSE users.password_hash END,
      updated_at=now()
    `, [
    listener.name,
    listener.username.toLowerCase(),
    phone,
    listener.employeeCode,
    passwordHash,
    'A calm listener who gives every conversation time and attention.',
    config.resetSeededPasswords,
    ]);
  } catch (error) {
    if (error.code !== '23505') throw error;
    console.warn('Initial listener was not changed because its phone, username, or listener ID already belongs to another account.');
    return false;
  }
  return true;
}

async function reconcileInterruptedListenerSessions() {
  await pool.query(`
    UPDATE listener_activity_sessions
    SET ended_at=now(),
        duration_seconds=GREATEST(0, EXTRACT(EPOCH FROM (now()-started_at))::int),
        end_reason='Server restarted'
    WHERE ended_at IS NULL
  `);
  await pool.query(`
    UPDATE users
    SET listener_availability='offline', updated_at=now()
    WHERE role='employee' AND listener_availability<>'offline'
  `);
}

async function reconcileInterruptedCalls() {
  const interrupted = await pool.query(`
    UPDATE calls
    SET status=CASE WHEN status='active' THEN 'ended' ELSE 'cancelled' END,
        ended_at=COALESCE(ended_at,now()),
        end_reason=COALESCE(end_reason,'Server restarted')
    WHERE status IN ('ringing','connecting','active')
    RETURNING id
  `);

  for (const row of interrupted.rows) {
    try {
      await settleCall(row.id);
    } catch (error) {
      console.warn(`Could not settle interrupted call ${row.id}:`, error.message);
    }
  }
}

(async () => {
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
  await reconcileInterruptedCalls();
  await reconcileInterruptedListenerSessions();
  await upsertAdmin();
  const listenerCreated = await upsertInitialListener();

  console.log('We Met database initialized successfully.');
  console.log(`Admin: ${config.admin.username}`);
  if (listenerCreated) console.log(`Initial listener: ${config.initialListener.username}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
