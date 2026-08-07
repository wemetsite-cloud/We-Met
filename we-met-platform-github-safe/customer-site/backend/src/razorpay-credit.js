function normalisePayment(payment) {
  return {
    id: String(payment?.id || ''),
    orderId: String(payment?.order_id || ''),
    amount: Number(payment?.amount),
    currency: String(payment?.currency || '').toUpperCase(),
    status: String(payment?.status || '').toLowerCase(),
    captured: payment?.captured === true || String(payment?.status || '').toLowerCase() === 'captured',
    method: String(payment?.method || '').slice(0, 50) || null,
    errorCode: String(payment?.error_code || '').slice(0, 120) || null,
    errorDescription: String(payment?.error_description || '').slice(0, 500) || null,
  };
}

function validateAgainstOrder(payment, order, { strict = false } = {}) {
  if (!payment.id || !payment.orderId) throw new Error('Razorpay payment data is incomplete.');
  if (payment.orderId !== order.razorpay_order_id) throw new Error('Razorpay order mismatch.');
  if ((strict && !Number.isInteger(payment.amount)) || (Number.isInteger(payment.amount) && payment.amount !== Number(order.amount_paise))) {
    throw new Error('Razorpay payment amount mismatch.');
  }
  if ((strict && !payment.currency) || (payment.currency && payment.currency !== String(order.currency).toUpperCase())) {
    throw new Error('Razorpay payment currency mismatch.');
  }
}

async function updatePaymentState(client, rawPayment) {
  const payment = normalisePayment(rawPayment);
  if (!payment.orderId) return { matched: false };

  const result = await client.query(
    'SELECT * FROM razorpay_orders WHERE razorpay_order_id=$1 FOR UPDATE',
    [payment.orderId],
  );
  const order = result.rows[0];
  if (!order) return { matched: false };
  validateAgainstOrder(payment, order);
  if (order.status === 'paid') return { matched: true, credited: false, order };

  const nextStatus = payment.status === 'captured'
    ? 'paid'
    : (payment.status === 'authorized' ? 'authorized' : (payment.status === 'failed' ? 'failed' : 'attempted'));

  const updated = await client.query(`
    UPDATE razorpay_orders
    SET status=$2,last_payment_id=$3,payment_method=COALESCE($4,payment_method),
        failure_code=$5,failure_description=$6,updated_at=now()
    WHERE id=$1
    RETURNING *
  `, [order.id, nextStatus, payment.id || null, payment.method, payment.errorCode, payment.errorDescription]);

  return { matched: true, credited: false, order: updated.rows[0] };
}

async function creditCapturedPayment(client, rawPayment) {
  const payment = normalisePayment(rawPayment);
  if (!payment.captured || payment.status !== 'captured') {
    return updatePaymentState(client, rawPayment);
  }

  const result = await client.query(
    'SELECT * FROM razorpay_orders WHERE razorpay_order_id=$1 FOR UPDATE',
    [payment.orderId],
  );
  const order = result.rows[0];
  if (!order) return { matched: false, credited: false };
  validateAgainstOrder(payment, order, { strict: true });

  if (order.credited_at) {
    return { matched: true, credited: false, order };
  }

  const ledger = await client.query(`
    INSERT INTO wallet_transactions(customer_id,seconds_delta,type,note,reference_id)
    VALUES($1,$2,'payment',$3,$4)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [order.customer_id, order.seconds, `${order.plan_name} · Razorpay payment`, order.id]);

  let balanceSeconds;
  let notification = null;
  if (ledger.rows[0]) {
    const user = await client.query(`
      UPDATE users
      SET balance_seconds=balance_seconds+$2,updated_at=now()
      WHERE id=$1
      RETURNING balance_seconds
    `, [order.customer_id, order.seconds]);
    balanceSeconds = user.rows[0]?.balance_seconds;

    const notice = await client.query(`
      INSERT INTO notifications(user_id,title,body)
      VALUES($1,'Payment successful',$2)
      RETURNING id,title,body,created_at
    `, [
      order.customer_id,
      `${Math.round(Number(order.seconds) / 60)} minutes were added to your wallet.`,
    ]);
    notification = notice.rows[0] || null;
  } else {
    const user = await client.query('SELECT balance_seconds FROM users WHERE id=$1', [order.customer_id]);
    balanceSeconds = user.rows[0]?.balance_seconds;
  }

  const updated = await client.query(`
    UPDATE razorpay_orders
    SET status='paid',razorpay_payment_id=$2,last_payment_id=$2,
        payment_method=COALESCE($3,payment_method),failure_code=NULL,
        failure_description=NULL,captured_at=COALESCE(captured_at,now()),
        credited_at=COALESCE(credited_at,now()),updated_at=now()
    WHERE id=$1
    RETURNING *
  `, [order.id, payment.id, payment.method]);

  return {
    matched: true,
    credited: Boolean(ledger.rows[0]),
    order: updated.rows[0],
    balanceSeconds,
    notification,
  };
}

module.exports = { normalisePayment, updatePaymentState, creditCapturedPayment };
