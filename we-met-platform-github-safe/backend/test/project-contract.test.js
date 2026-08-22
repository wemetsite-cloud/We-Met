const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

test('ships authenticated Razorpay checkout without exposing the secret to the frontend', () => {
  const routes = read('backend', 'src', 'routes', 'razorpay.js');
  const server = read('backend', 'server.js');
  const customerHtml = read('customer-site', 'index.html');
  const customerApp = read('customer-site', 'app.js');
  const backendConfig = read('backend', 'src', 'config.js');
  const packageJson = JSON.parse(read('backend', 'package.json'));
  assert.ok(packageJson.dependencies.razorpay);
  assert.match(server, /app\.use\('\/api', require\('\.\/src\/routes\/razorpay'\)\)/);
  assert.match(routes, /router\.post\('\/create-order'/);
  assert.match(routes, /router\.post\('\/verify-payment'/);
  assert.match(routes, /requireRole\('customer'\)/);
  assert.match(routes, /verifyPaymentSignature/);
  assert.match(routes, /status='paid'/);
  assert.match(customerHtml, /https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js/);
  assert.match(customerApp, /razorpay_payment_id/);
  assert.doesNotMatch(customerApp, /RAZORPAY_KEY_SECRET|keySecret/);
  assert.match(backendConfig, /path\.join\(__dirname, '\.\.', '\.\.', '\.env'\)/);
  assert.match(read('.gitignore'), /^\.env$/m);
});

test('keeps talk-time plans behind customer authentication', () => {
  const publicRoutes = read('backend', 'src', 'routes', 'public.js');
  const customerRoutes = read('backend', 'src', 'routes', 'customer.js');
  const landing = read('customer-site', 'index.html').split('<section id="dashboard"')[0];
  assert.doesNotMatch(publicRoutes, /router\.get\(['"]\/plans/);
  assert.match(customerRoutes, /router\.get\(['"]\/plans/);
  assert.doesNotMatch(landing, /id="plansGrid"|class="plans-grid"/);
});

test('keeps listener work-session analytics private to admin while listener sees talk-time only', () => {
  assert.match(read('backend', 'database', 'schema.sql'), /listener_activity_sessions/);
  assert.match(read('backend', 'src', 'routes', 'employee.js'), /router\.get\(['"]\/activity/);
  assert.match(read('backend', 'src', 'routes', 'admin.js'), /today_work_seconds/);
  assert.doesNotMatch(read('employee-site', 'index.html'), /id="(?:todayWork|weekWork|todayBreak)"/);
  assert.match(read('employee-site', 'index.html'), /id="weekTime"/);
  assert.match(read('employee-site', 'index.html'), /id="activityList"/);
  assert.match(read('admin-site', 'index.html'), /id="listenerTodayWork"/);
  assert.match(read('backend', 'src', 'socket.js'), /currentRuntime\s*\?\s*\(currentRuntime\.status === 'ringing' \? 'ringing' : 'busy'\)/);
});

test('ships listener earnings, ₹100 withdrawal requests and immutable wallet history', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const adminRoutes = read('backend', 'src', 'routes', 'admin.js');
  const employeeRoutes = read('backend', 'src', 'routes', 'employee.js');
  const listenerHtml = read('employee-site', 'index.html');
  const adminHtml = read('admin-site', 'index.html');
  assert.match(schema, /listener_wallet_transactions/);
  assert.match(schema, /listener_withdrawal_requests/);
  assert.match(schema, /uq_listener_wallet_call_credit/);
  assert.match(schema, /uq_listener_wallet_payout/);
  assert.match(schema, /uq_listener_pending_withdrawal/);
  assert.match(schema, /listener_rate_paise/);
  assert.match(schema, /IF NOT earnings_column_exists THEN/);
  assert.doesNotMatch(schema, /WHERE earnings_settled_at IS NULL\s+AND status IN/);
  assert.match(adminRoutes, /router\.get\('\/withdrawals'/);
  assert.match(adminRoutes, /router\.patch\('\/withdrawals\/:id'/);
  assert.doesNotMatch(adminRoutes, /\/listener-wallets\/:id\/mark-paid/);
  assert.match(adminRoutes, /FOR UPDATE/);
  assert.match(employeeRoutes, /router\.get\(['"]\/wallet/);
  assert.match(employeeRoutes, /MIN_WITHDRAWAL_PAISE = 10_000/);
  assert.match(employeeRoutes, /router\.post\('\/wallet\/withdrawals'/);
  assert.match(employeeRoutes, /\/wallet\/payout-details/);
  assert.match(listenerHtml, /id="tab-wallet"/);
  assert.match(listenerHtml, /id="walletBalance"/);
  assert.match(listenerHtml, /id="withdrawalForm"/);
  assert.match(adminHtml, /id="page-payouts"/);
  assert.match(adminHtml, /id="payoutDueTotal"/);
  assert.match(adminHtml, /id="withdrawalRequests"/);
  assert.doesNotMatch(adminHtml, /id="page-payments"|UPI payments/);
});

test('isolates portal sessions by role and clears stale mismatched tokens', () => {
  const middleware = read('backend', 'src', 'middleware.js');
  const portals = [
    ['admin-site', 'admin', 'we_met_admin_token'],
    ['employee-site', 'employee', 'we_met_listener_token'],
    ['customer-site', 'customer', 'we_met_customer_token'],
  ];
  assert.match(middleware, /code: 'ROLE_MISMATCH'/);
  assert.match(middleware, /actualRole/);
  for (const [site, role, tokenKey] of portals) {
    const api = read(site, 'api.js');
    const config = read(site, 'config.js');
    const serviceWorker = read(site, 'service-worker.js');
    assert.match(api, new RegExp(tokenKey));
    assert.match(api, /tokenRole\(token\)/);
    assert.match(api, /portal:session-invalid/);
    assert.match(config, new RegExp(`EXPECTED_ROLE: '${role}'`));
    assert.match(serviceWorker, /const VERSION = '6\.8\.0'/);
  }
});

test('provides full clickable admin profiles and administrator audit history', () => {
  const adminApp = read('admin-site', 'app.js');
  assert.match(adminApp, /data-user-profile/);
  assert.match(adminApp, /\/api\/admin\/users\/\$\{id\}\/details/);
  assert.match(adminApp, /activitySessions/);
  assert.match(adminApp, /\/api\/admin\/audit-log/);
  assert.match(read('admin-site', 'index.html'), /id="page-audit"/);
});

test('binds password recovery keys to their exact request identifiers', () => {
  const authRoutes = read('backend', 'src', 'routes', 'auth.js');
  assert.match(authRoutes, /validRecoveryCredentials\(requestId, recoveryKey\)/);
  assert.equal((authRoutes.match(/WHERE recovery_key_hash=\$1 AND id=\$2/g) || []).length, 2);
});

test('keeps generic administrator account actions away from administrator accounts', () => {
  const adminRoutes = read('backend', 'src', 'routes', 'admin.js');
  assert.ok((adminRoutes.match(/WHERE id = \$1 AND role <> 'admin'/g) || []).length >= 2);
});

test('includes public company, contact, safety and policy pages', () => {
  for (const name of ['about.html', 'contact.html', 'terms.html', 'privacy.html', 'refund.html', 'safety.html', 'robots.txt', 'sitemap.xml']) {
    assert.equal(fs.existsSync(path.join(projectRoot, 'customer-site', name)), true, `${name} is missing`);
  }
});

test('uses unique element ids in each primary interface', () => {
  for (const site of ['customer-site', 'admin-site', 'employee-site']) {
    const html = read(site, 'index.html');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], `${site} contains duplicate ids`);
  }
});


test('retires manual UPI uploads while preserving customer privacy polish', () => {
  const customerHtml = read('customer-site', 'index.html');
  const customerApp = read('customer-site', 'app.js');
  const server = read('backend', 'server.js');
  const schema = read('backend', 'database', 'schema.sql');
  assert.match(customerHtml, /id="listenerDiscovery"/);
  assert.match(customerApp, /Listeners are available now/);
  assert.doesNotMatch(customerApp, /\$\{malayalamAvailable\} Malayalam listener/);
  assert.doesNotMatch(server, /routes\/manual-payments/);
  assert.doesNotMatch(customerHtml, /manualPaymentForm|manualProof|payWithGooglePay|page-payments/);
  assert.doesNotMatch(customerApp, /manual-payments|submitManualPayment|loadPayments/);
  assert.match(customerApp, /show\('#listenerDiscovery', false\)/);
  assert.match(schema, /\('Long Connect',199900,14400,false,true,60\)/);
});
