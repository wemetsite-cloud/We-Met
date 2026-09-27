const db = require('./db');

const VALID_STATES = new Set(['online', 'break']);

async function transition(employeeId, nextState = null, reason = 'Availability changed') {
  if (nextState !== null && !VALID_STATES.has(nextState)) {
    throw new Error('Invalid listener activity state.');
  }

  return db.transaction(async (client) => {
    const openResult = await client.query(`
      SELECT id,state,started_at
      FROM listener_activity_sessions
      WHERE employee_id=$1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
      FOR UPDATE
    `, [employeeId]);
    const openSession = openResult.rows[0];

    if (openSession?.state === nextState) return openSession;

    if (openSession) {
      await client.query(`
        UPDATE listener_activity_sessions
        SET ended_at=now(),
            duration_seconds=GREATEST(0,EXTRACT(EPOCH FROM (now()-started_at))::int),
            end_reason=$2
        WHERE id=$1
      `, [openSession.id, String(reason || 'Availability changed').slice(0, 250)]);
    }

    if (!nextState) return null;
    const created = await client.query(`
      INSERT INTO listener_activity_sessions(employee_id,state)
      VALUES($1,$2)
      RETURNING id,state,started_at
    `, [employeeId, nextState]);
    return created.rows[0];
  });
}

async function touchLastSeen(employeeId) {
  await db.query(`
    UPDATE users SET last_seen_at=now(),updated_at=now()
    WHERE id=$1 AND role='employee'
  `, [employeeId]);
}

module.exports = { transition, touchLastSeen, VALID_STATES };
