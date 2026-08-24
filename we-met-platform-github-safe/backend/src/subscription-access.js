'use strict';

async function activeSubscription(client, customerId, employeeId, { lock = false } = {}) {
  const result = await client.query(`
    SELECT *
    FROM listener_subscriptions
    WHERE customer_id=$1 AND employee_id=$2
      AND status='active'
      AND current_period_end IS NOT NULL
      AND current_period_end>now()
    ORDER BY current_period_end DESC
    LIMIT 1
    ${lock ? 'FOR UPDATE' : ''}
  `, [customerId, employeeId]);
  return result.rows[0] || null;
}

async function requireActiveSubscription(client, customerId, employeeId) {
  const subscription = await activeSubscription(client, customerId, employeeId);
  if (!subscription) {
    throw Object.assign(new Error('Subscribe to this listener to open photos, messages and calls.'), {
      status: 402,
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  return subscription;
}

function listenerPublicName(user) {
  return String(user?.username || user?.name || 'Listener').trim() || 'Listener';
}

module.exports = { activeSubscription, requireActiveSubscription, listenerPublicName };
