const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { hashPassword } = require('../src/auth');
const config = require('../src/config');

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
  if (!listener.email || !listener.password) return false;

  const passwordHash = await hashPassword(listener.password);
  await pool.query(`
    INSERT INTO users(role,name,email,employee_code,password_hash,bio,listener_language)
    VALUES('employee',$1,$2,$3,$4,$5,'Malayalam')
    ON CONFLICT(email) DO UPDATE SET
      name=EXCLUDED.name,
      employee_code=EXCLUDED.employee_code,
      role='employee',
      password_hash=CASE WHEN $6 THEN EXCLUDED.password_hash ELSE users.password_hash END,
      updated_at=now()
  `, [
    listener.name,
    listener.email.toLowerCase(),
    listener.employeeCode,
    passwordHash,
    'A calm listener who gives every conversation time and attention.',
    config.resetSeededPasswords,
  ]);
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

(async () => {
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
  await reconcileInterruptedListenerSessions();
  await upsertAdmin();
  const listenerCreated = await upsertInitialListener();

  console.log('We Met database initialized successfully.');
  console.log(`Admin: ${config.admin.username}`);
  if (listenerCreated) console.log(`Initial listener: ${config.initialListener.email}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
