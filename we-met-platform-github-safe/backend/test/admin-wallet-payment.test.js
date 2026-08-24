const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret-that-is-longer-than-forty-eight-characters';
process.env.ADMIN_PASSWORD ||= 'test-admin-password';

const express = require('express');
const { signToken } = require('../src/auth');
const db = require('../src/db');
const adminRoutes = require('../src/routes/admin');

function queryText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

test('admin can record an offline listener payment without invoking a payout service', async (t) => {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  const calls = [];
  const notifications = [];

  db.query = async (sql) => {
    const statement = queryText(sql);
    if (statement.includes('FROM users WHERE id=$1')) {
      return {
        rows: [{
          id: 'admin-1', role: 'admin', name: 'Administrator', status: 'active',
          auth_version: 0, suspended_until: null,
        }],
      };
    }
    if (statement.includes('INSERT INTO admin_audit_log')) return { rows: [] };
    throw new Error(`Unexpected top-level query: ${statement}`);
  };

  db.transaction = async (callback) => callback({
    query: async (sql, params = []) => {
      const statement = queryText(sql);
      calls.push({ statement, params });
      if (statement.includes("WHERE id=$1 AND role='employee'")) {
        return { rows: [{ id: 'listener-1', name: 'Listener One' }] };
      }
      if (statement.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (statement.includes("WHERE type='payout' AND lower(payment_reference)")) return { rows: [] };
      if (statement.includes('COALESCE(SUM(amount_paise),0)')) return { rows: [{ balance_paise: '15000' }] };
      if (statement.includes('INSERT INTO listener_wallet_transactions')) {
        return {
          rows: [{
            id: 'transaction-1', employee_id: 'listener-1', type: 'payout',
            amount_paise: -10000, payment_reference: 'BANK-123', note: 'Paid by bank',
          }],
        };
      }
      if (statement.includes('INSERT INTO notifications')) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${statement}`);
    },
  });

  const app = express();
  app.use(express.json());
  app.locals.notifyUser = async (userId, payload) => notifications.push({ userId, payload });
  app.use('/api/admin', adminRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.query = originalQuery;
    db.transaction = originalTransaction;
  });

  const token = signToken({ id: 'admin-1', role: 'admin', name: 'Administrator', auth_version: 0 });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/listener-wallets/listener-1/mark-paid`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amountPaise: 10000, paymentReference: 'BANK-123', note: 'Paid by bank' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.paidPaise, 10000);
  assert.equal(body.balancePaise, 5000);
  assert.equal(body.transaction.amount_paise, -10000);
  assert.equal(
    calls.some(({ statement }) => statement.includes('razorpay') || statement.includes('payouts.create')),
    false,
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, 'listener-1');
});
