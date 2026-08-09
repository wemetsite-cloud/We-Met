const db = require('./db');
const { calculateListenerEarnings, wholeNonNegative } = require('./listener-earnings');

async function settleCall(callId, database = db) {
  if (!callId) return null;

  return database.transaction(async (client) => {
    const callResult = await client.query(`
      SELECT id,customer_id,employee_id,billed_seconds,listener_rate_paise,
             listener_earnings_paise,earnings_settled_at
      FROM calls
      WHERE id=$1
      FOR UPDATE
    `, [callId]);
    const call = callResult.rows[0];
    if (!call) return null;

    const billedSeconds = wholeNonNegative(call.billed_seconds);
    if (billedSeconds > 0) {
      await client.query(`
        INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
        VALUES($1,$2,'call_debit','Voice call',$3)
        ON CONFLICT DO NOTHING
      `, [call.customer_id, -billedSeconds, call.id]);
    }

    if (call.earnings_settled_at) {
      return {
        callId: call.id,
        billedSeconds,
        earningsPaise: wholeNonNegative(call.listener_earnings_paise),
        alreadySettled: true,
      };
    }

    // Lock the listener row as the common serialization point for call credits,
    // administrator adjustments and "mark paid" operations.
    const employee = await client.query(`
      SELECT id FROM users
      WHERE id=$1 AND role='employee'
      FOR UPDATE
    `, [call.employee_id]);
    if (!employee.rows[0]) {
      throw Object.assign(new Error('The listener account for this call no longer exists.'), { status: 409 });
    }

    const ratePaise = wholeNonNegative(call.listener_rate_paise);
    const earningsPaise = calculateListenerEarnings(billedSeconds, ratePaise);

    if (earningsPaise > 0) {
      await client.query(`
        INSERT INTO listener_wallet_transactions(
          employee_id,type,amount_paise,reference_id,billed_seconds,
          rate_paise_per_minute,note
        )
        VALUES($1,'call_credit',$2,$3,$4,$5,'Connected call earnings')
        ON CONFLICT DO NOTHING
      `, [call.employee_id, earningsPaise, call.id, billedSeconds, ratePaise]);
    }

    await client.query(`
      UPDATE calls
      SET listener_earnings_paise=$2,earnings_settled_at=now()
      WHERE id=$1 AND earnings_settled_at IS NULL
    `, [call.id, earningsPaise]);

    return {
      callId: call.id,
      billedSeconds,
      ratePaise,
      earningsPaise,
      alreadySettled: false,
    };
  });
}

module.exports = { settleCall };
