'use strict';

/* Consolidated to keep the GitHub-safe package below the 100-file upload limit. */

{
  /* admin-wallet-payment.test.js */
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
}

{
  /* frontend-contract.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const sites = ['customer-site', 'admin-site', 'employee-site'];

function localReference(value) {
  const clean = value.split('#')[0].split('?')[0];
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  return clean;
}

test('every local HTML asset and page reference resolves to a shipped file', () => {
  for (const site of sites) {
    const siteRoot = path.join(projectRoot, site);
    for (const name of fs.readdirSync(siteRoot).filter((entry) => entry.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(siteRoot, name), 'utf8');
      for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
        const reference = localReference(match[1]);
        if (!reference) continue;
        const target = path.resolve(siteRoot, path.dirname(name), reference);
        assert.equal(fs.existsSync(target), true, `${site}/${name} references missing ${reference}`);
      }
    }
  }
});

test('all web manifests are valid and their icons resolve', () => {
  for (const site of sites) {
    const siteRoot = path.join(projectRoot, site);
    const manifest = JSON.parse(fs.readFileSync(path.join(siteRoot, 'manifest.webmanifest'), 'utf8'));
    assert.ok(manifest.name);
    assert.ok(manifest.short_name);
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
    for (const icon of manifest.icons) {
      const target = icon.src.startsWith('/')
        ? path.join(projectRoot, icon.src.replace(/^\/+/, ''))
        : path.resolve(siteRoot, icon.src);
      assert.equal(fs.existsSync(target), true, `${site} manifest icon ${icon.src} is missing`);
    }
  }
});

test('the public sitemap only points to shipped customer pages', () => {
  const siteRoot = path.join(projectRoot, 'customer-site');
  const sitemap = fs.readFileSync(path.join(siteRoot, 'sitemap.xml'), 'utf8');
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.ok(locations.length >= 6);
  for (const location of locations) {
    const url = new URL(location);
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    assert.equal(fs.existsSync(path.join(siteRoot, name)), true, `sitemap page ${name} is missing`);
  }
});

test('every admin page and listener tab navigation target exists', () => {
  const admin = fs.readFileSync(path.join(projectRoot, 'admin-site', 'index.html'), 'utf8');
  for (const match of admin.matchAll(/data-page="([^"]+)"/g)) {
    assert.match(admin, new RegExp(`id="page-${match[1]}"`), `admin page ${match[1]} is missing`);
  }

  const listener = fs.readFileSync(path.join(projectRoot, 'employee-site', 'index.html'), 'utf8');
  for (const match of listener.matchAll(/data-tab="([^"]+)"/g)) {
    assert.match(listener, new RegExp(`id="tab-${match[1]}"`), `listener tab ${match[1]} is missing`);
  }
});

test('the customer portal ships the v8 membership layout and phone-first authentication', () => {
  const siteRoot = path.join(projectRoot, 'customer-site');
  const html = fs.readFileSync(path.join(siteRoot, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(siteRoot, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(siteRoot, 'app.js'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(siteRoot, 'service-worker.js'), 'utf8');

  assert.match(html, /id="tabs"[\s\S]*data-tab="home"[\s\S]*data-tab="subscriptions"[\s\S]*data-tab="messages"[\s\S]*data-tab="wallet"[\s\S]*data-tab="profile"/);
  assert.match(html, /class="auth-progress-line"/);
  for (const step of ['welcome', 'phone', 'password', 'otp', 'details']) {
    assert.match(html, new RegExp(`data-phone-step="${step}"`));
  }
  assert.match(html, /id="walletBalance"/);
  assert.equal((html.match(/id="walletBalance"/g) || []).length, 1);
  assert.match(css, /\.wallet-plan-card/);
  assert.match(css, /\.listener-card-v8/);
  assert.match(app, /data-buy-plan/);
  assert.match(app, /type="button">Pay \$\{P\.money\(plan\.price_paise\)\}<\/button>/);
  assert.match(app, /data-subscribe/);
  assert.match(app, /Calls need only wallet talk-time/);
  assert.doesNotMatch(app, /data-video|Start video call/);
  assert.match(serviceWorker, /const VERSION = '8\.9\.17'/);
});
}

{
  /* listener-wallet.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateListenerEarnings } = require('../src/listener-earnings');

test('calculates listener earnings from connected seconds and the rate snapshot', () => {
  assert.equal(calculateListenerEarnings(60, 500), 500);
  assert.equal(calculateListenerEarnings(30, 500), 250);
  assert.equal(calculateListenerEarnings(65, 700), 758);
  assert.equal(calculateListenerEarnings(1, 500), 8);
});

test('never creates negative or invalid listener earnings', () => {
  assert.equal(calculateListenerEarnings(0, 500), 0);
  assert.equal(calculateListenerEarnings(-60, 500), 0);
  assert.equal(calculateListenerEarnings(60, -500), 0);
  assert.equal(calculateListenerEarnings('invalid', 500), 0);
});
}

{
  /* manual-payment.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectImageMime,
  normaliseTransferReference,
  publicSubmission,
  upiPaymentUri,
} = require('../src/manual-payment');

test('normalises valid UPI transaction references and rejects unsafe values', () => {
  assert.equal(normaliseTransferReference('  4234 5678 9012  '), '423456789012');
  assert.equal(normaliseTransferReference('nesf/upi:abc-123'), 'NESF/UPI:ABC-123');
  assert.equal(normaliseTransferReference('short'), '');
  assert.equal(normaliseTransferReference('<script>alert(1)</script>'), '');
});

test('builds a private exact-amount payload for the server-rendered QR', () => {
  const uri = upiPaymentUri({
    upiId: 'merchant@example',
    payeeName: 'We Met Test',
    amountPaise: 4900,
    reference: 'WM-TEST-123456',
    note: 'We Met test payment',
  });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'upi:');
  assert.equal(parsed.hostname, 'pay');
  assert.equal(parsed.searchParams.get('pa'), 'merchant@example');
  assert.equal(parsed.searchParams.get('am'), '49.00');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('tr'), 'WM-TEST-123456');
  assert.match(uri, /pn=We%20Met%20Test/);
  assert.match(uri, /tn=We%20Met%20test%20payment/);
  assert.doesNotMatch(uri, /\+/);
  assert.doesNotMatch(uri, /gpay:|intent:/i);
});


test('builds the configured UPI account identity and unique transaction reference', () => {
  const uri = upiPaymentUri({
    upiId: 'paytm.s3hc53w@pty',
    payeeName: 'Sabith Salah K P',
    amountPaise: 199900,
    reference: 'WM-TEST-1999',
    note: 'We Met WM-TEST-1999',
  });
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('pa'), 'paytm.s3hc53w@pty');
  assert.equal(parsed.searchParams.get('pn'), 'Sabith Salah K P');
  assert.equal(parsed.searchParams.get('tn'), 'We Met WM-TEST-1999');
  assert.equal(parsed.searchParams.get('am'), '1999.00');
  assert.equal(parsed.searchParams.get('tr'), 'WM-TEST-1999');
});

test('accepts only recognised raster-image signatures', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = Buffer.from('RIFF0000WEBP', 'ascii');
  const svg = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8');
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(webp), 'image/webp');
  assert.equal(detectImageMime(svg), '');
});

test('customer submission output excludes stored image bytes and payee details', () => {
  const output = publicSubmission({
    id: 'payment-1',
    plan_id: 'plan-1',
    plan_name: 'Starter',
    amount_paise: 4900,
    seconds: 300,
    payment_method: 'upi',
    checkout_reference: 'WM-TEST-1',
    destination_last4: '3453',
    utr_reference: '423456789012',
    proof_size: 1200,
    proof_data: Buffer.from('private'),
    payee_upi_id: 'private@example',
    status: 'pending',
  });
  assert.equal(output.method, 'upi_direct');
  assert.equal(output.proof_available, true);
  assert.equal('proof_data' in output, false);
  assert.equal('payee_upi_id' in output, false);
});
}

{
  /* profile-image.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfileImage, profileImageReference, decodeProfileImage } = require('../src/profile-image');

test('accepts only the shipped listener avatar names', () => {
  assert.equal(normalizeProfileImage('avatar-01.svg'), 'avatar-01.svg');
  assert.equal(normalizeProfileImage('avatar-20.svg'), 'avatar-20.svg');
  assert.equal(normalizeProfileImage('avatar-21.svg'), false);
  assert.equal(normalizeProfileImage('../avatar-01.svg'), false);
});

test('accepts supported compressed data images and exposes only a lightweight public reference', () => {
  const data = `data:image/jpeg;base64,${Buffer.from('small-profile-image').toString('base64')}`;
  assert.equal(normalizeProfileImage(data), data);
  assert.equal(profileImageReference(data, 'abc-123'), 'photo:abc-123');
  const decoded = decodeProfileImage(data);
  assert.equal(decoded.mime, 'image/jpeg');
  assert.equal(decoded.buffer.toString(), 'small-profile-image');
});

test('rejects svg data uploads and unsafe arbitrary profile-image strings', () => {
  assert.equal(normalizeProfileImage('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(normalizeProfileImage('https://example.com/photo.jpg'), false);
});
}

{
  /* project-contract.test.js */
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
  assert.match(routes, /router\.post\('\/create-order', authenticate, requireRole\('customer'\),/);
  assert.match(routes, /router\.post\('\/verify-payment', authenticate, requireRole\('customer'\),/);
  assert.doesNotMatch(routes, /router\.use\(authenticate, requireRole\('customer'\)\)/);
  assert.match(routes, /verifyPaymentSignature/);
  assert.match(routes, /status='paid'/);
  assert.doesNotMatch(customerHtml, /id="walletCheckoutSection"/);
  assert.match(customerHtml, /<script src="https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js"><\/script>/);
  assert.match(customerApp, /async function openPayment/);
  assert.match(customerApp, /new window\.Razorpay/);
  assert.match(customerApp, /checkout\.open\(\)/);
  assert.match(customerApp, /redirect: false/);
  assert.match(customerApp, /razorpay_payment_id/);
  assert.doesNotMatch(customerApp, /checkout\.html|short_url|window\.open|location\.(?:assign|replace)/);
  assert.equal(fs.existsSync(path.join(projectRoot, 'customer-site', 'checkout.html')), false);
  assert.doesNotMatch(customerApp, /RAZORPAY_KEY_SECRET|keySecret/);
  assert.match(backendConfig, /path\.join\(__dirname, '\.\.', '\.\.', '\.env'\)/);
  assert.match(read('.gitignore'), /^\.env$/m);
});

test('limits Razorpay customer-role checks to payment endpoints', () => {
  const routes = read('backend', 'src', 'routes', 'razorpay.js');
  const protectedPaymentRoutes = routes.match(/router\.post\([^\n]+authenticate, requireRole\('customer'\)/g) || [];
  assert.equal(protectedPaymentRoutes.length, 2);
  assert.doesNotMatch(routes, /router\.use\([^\n]*requireRole\('customer'\)/);
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

test('ships listener earnings with audited listener withdrawal requests', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const adminRoutes = read('backend', 'src', 'routes', 'admin.js');
  const employeeRoutes = read('backend', 'src', 'routes', 'employee.js');
  const listenerHtml = read('employee-site', 'index.html');
  const adminHtml = read('admin-site', 'index.html');
  assert.match(schema, /listener_wallet_transactions/);
  assert.match(schema, /listener_withdrawal_requests/);
  assert.match(schema, /uq_listener_wallet_call_credit/);
  assert.match(schema, /uq_listener_wallet_payout/);
  assert.match(schema, /WHERE status='pending'/);
  assert.match(schema, /listener_rate_paise/);
  assert.match(schema, /IF NOT earnings_column_exists THEN/);
  assert.doesNotMatch(schema, /WHERE earnings_settled_at IS NULL\s+AND status IN/);
  assert.match(adminRoutes, /router\.get\('\/listener-wallets'/);
  assert.match(adminRoutes, /router\.post\('\/listener-wallets\/:id\/mark-paid'/);
  assert.match(adminRoutes, /router\.post\('\/listener-wallets\/:id\/adjust'/);
  assert.match(adminRoutes, /router\.get\('\/withdrawals'/);
  assert.match(adminRoutes, /router\.patch\('\/withdrawals\/:id'/);
  assert.match(adminRoutes, /FOR UPDATE/);
  assert.match(employeeRoutes, /router\.get\(['"]\/wallet/);
  assert.match(employeeRoutes, /router\.patch\('\/payout-details'/);
  assert.match(employeeRoutes, /router\.post\('\/withdrawals'/);
  assert.match(listenerHtml, /id="tab-wallet"/);
  assert.match(listenerHtml, /id="walletBalance"/);
  assert.match(listenerHtml, /id="withdrawalForm"/);
  assert.match(listenerHtml, /id="listenerUpiId"/);
  assert.match(adminHtml, /id="page-wallets"/);
  assert.match(adminHtml, /id="listenerWalletBalance"/);
  assert.match(adminHtml, /Record paid/);
  assert.match(adminHtml, /id="page-withdrawals"/);
  assert.match(adminHtml, /id="page-payments"/);
  assert.match(adminHtml, /Listener credits/);
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
    assert.match(api, /isAuthError/);
    assert.match(api, /NETWORK_ERROR/);
    assert.match(config, new RegExp(`EXPECTED_ROLE: '${role}'`));
    assert.match(serviceWorker, /const VERSION = '8\.9\.17'/);
    assert.doesNotMatch(serviceWorker, /client\.navigate/);
    assert.doesNotMatch(read(site, 'app.js'), /registration\.update\(\)/);
  }
});

test('keeps portal startup non-blocking and provides stable same-origin staff URLs', () => {
  const server = read('backend', 'server.js');
  const listenerApp = read('employee-site', 'app.js');
  const customerApp = read('customer-site', 'app.js');
  const publicRoutes = read('backend', 'src', 'routes', 'public.js');
  assert.match(server, /app\.use\('\/listener', portalStatic\.employee\)/);
  assert.match(server, /app\.get\('\/listener'/);
  assert.doesNotMatch(listenerApp, /await registerServiceWorker\(\)/);
  assert.doesNotMatch(customerApp, /await registerServiceWorker\(\)/);
  assert.doesNotMatch(publicRoutes, /directUpiEnabled/);
  assert.doesNotMatch(publicRoutes, /verification screenshots|successful-payment screenshot/);
});

test('provides full clickable admin profiles and administrator audit history', () => {
  const adminApp = read('admin-site', 'app.js');
  assert.match(adminApp, /data-user-profile/);
  assert.match(adminApp, /\/api\/admin\/users\/\$\{id\}\/details/);
  assert.match(adminApp, /activitySessions/);
  assert.match(adminApp, /\/api\/admin\/audit-log/);
  assert.match(read('admin-site', 'index.html'), /id="page-audit"/);
});

test('uses single-use SMS verification tokens for password recovery', () => {
  const authRoutes = read('backend', 'src', 'routes', 'auth.js');
  assert.match(authRoutes, /router\.post\('\/forgot-password'/);
  assert.match(authRoutes, /purpose: 'password_reset'/);
  assert.match(authRoutes, /response\.resetToken = oneTimeToken/);
  assert.match(authRoutes, /router\.post\('\/password-reset\/complete'/);
  assert.match(authRoutes, /registrationTokenHash\(resetToken\)/);
  assert.doesNotMatch(authRoutes, /validRecoveryCredentials|recoveryKey/);
});

test('removes administrator password-reset controls and endpoints', () => {
  const adminRoutes = read('backend', 'src', 'routes', 'admin.js');
  const adminHtml = read('admin-site', 'index.html');
  assert.doesNotMatch(adminHtml, /data-page="resets"|page-resets|Password resets/);
  assert.doesNotMatch(adminRoutes, /password-resets|reset-password/);
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


test('retires manual UPI uploads while preserving the private listener directory', () => {
  const customerHtml = read('customer-site', 'index.html');
  const customerApp = read('customer-site', 'app.js');
  const server = read('backend', 'server.js');
  const schema = read('backend', 'database', 'schema.sql');
  assert.match(customerHtml, /id="listenerDiscovery"/);
  assert.match(customerApp, /loadDirectory/);
  assert.match(customerApp, /listener-card-v8/);
  assert.doesNotMatch(server, /routes\/manual-payments/);
  assert.doesNotMatch(customerHtml, /manualPaymentForm|manualProof|payWithGooglePay|page-payments/);
  assert.doesNotMatch(customerApp, /manual-payments|submitManualPayment|loadPayments/);
  assert.match(customerApp, /show\('#listenerDiscovery'\)/);
  assert.match(schema, /\('Long Connect',199900,14400,false,true,60\)/);
});
}

{
  /* push.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'test-jwt-secret-that-is-longer-than-forty-eight-characters-123456789',
  ADMIN_PASSWORD: 'test-admin-password',
  UPI_PAYMENT_PAYEE_NAME: 'We Met Test',
  UPI_PAYMENT_ID: 'test@upi',
});

const { notificationPayload } = require('../src/push');

test('creates a privacy-safe bounded Web Push payload', () => {
  const payload = JSON.parse(notificationPayload({
    title: `  ${'A'.repeat(200)}  `,
    body: 'Incoming private Malayalam call',
    tag: 'call-1',
    url: './',
    requireInteraction: true,
    renotify: true,
    vibrate: [3000, -20, 150, 90, 80, 70, 60, 50, 40],
  }));

  assert.equal(payload.title.length, 120);
  assert.equal(payload.body, 'Incoming private Malayalam call');
  assert.equal(payload.tag, 'call-1');
  assert.equal(payload.requireInteraction, true);
  assert.equal(payload.renotify, true);
  assert.deepEqual(payload.vibrate, [2000, 0, 150, 90, 80, 70, 60, 50]);
});

test('uses generic app-safe defaults when optional push fields are missing', () => {
  const payload = JSON.parse(notificationPayload());
  assert.equal(payload.title, 'We Met');
  assert.equal(payload.url, './');
  assert.equal(payload.tag, 'we-met-update');
  assert.equal(payload.requireInteraction, false);
});

test('supports a silent caller-name notification for a closed listener app', () => {
  const payload = JSON.parse(notificationPayload({
    title: 'Priya',
    body: 'is calling you',
    tag: 'we-met-call-1',
    silent: true,
    renotify: false,
    requireInteraction: false,
    vibrate: [500, 500],
  }));

  assert.equal(payload.title, 'Priya');
  assert.equal(payload.body, 'is calling you');
  assert.equal(payload.silent, true);
  assert.equal(payload.renotify, false);
  assert.equal(payload.requireInteraction, false);
  assert.deepEqual(payload.vibrate, []);
});
}

{
  /* razorpay-payment.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentSignature, verifyPaymentSignature } = require('../src/razorpay-payment');

test('verifies the documented Razorpay order and payment HMAC', () => {
  const orderId = 'order_Test123456789';
  const paymentId = 'pay_Test123456789';
  const keySecret = 'test-only-secret';
  const signature = paymentSignature(orderId, paymentId, keySecret);

  assert.equal(signature.length, 64);
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature, keySecret }), true);
});

test('rejects changed payment fields and malformed signatures', () => {
  const orderId = 'order_Test123456789';
  const paymentId = 'pay_Test123456789';
  const keySecret = 'test-only-secret';
  const signature = paymentSignature(orderId, paymentId, keySecret);

  assert.equal(verifyPaymentSignature({
    orderId,
    paymentId: 'pay_Changed123456',
    signature,
    keySecret,
  }), false);
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature: 'invalid', keySecret }), false);
});
}

{
  /* request-limit.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const createRateLimit = require('../src/request-limit');

function responseDouble() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('rate limiting is isolated by client and blocks only after the configured allowance', () => {
  const limit = createRateLimit({ windowMs: 60_000, max: 2, message: 'Please wait.' });
  let allowed = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = responseDouble();
    limit({ ip: '203.0.113.10' }, response, () => { allowed += 1; });
    if (attempt < 3) {
      assert.equal(response.statusCode, 200);
    } else {
      assert.equal(response.statusCode, 429);
      assert.deepEqual(response.body, { error: 'Please wait.' });
      assert.equal(response.headers['RateLimit-Remaining'], '0');
      assert.ok(Number(response.headers['Retry-After']) >= 1);
    }
  }

  const otherClient = responseDouble();
  limit({ ip: '198.51.100.24' }, otherClient, () => { allowed += 1; });
  assert.equal(allowed, 3);
  assert.equal(otherClient.statusCode, 200);
});
}

{
  /* v8-contract.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('v8 phone-first OTP flow covers customers and listeners without email registration', () => {
  const auth = read('backend', 'src', 'routes', 'auth.js');
  const sms = read('backend', 'src', 'sms.js');
  const customer = read('customer-site', 'index.html');
  const listener = read('employee-site', 'index.html');

  assert.match(auth, /router\.post\('\/phone\/start'/);
  assert.match(auth, /router\.post\('\/phone\/verify'/);
  assert.match(auth, /router\.post\('\/phone\/register\/customer'/);
  assert.match(auth, /router\.post\('\/phone\/register\/listener'/);
  assert.match(auth, /router\.post\('\/phone\/login\/start'/);
  assert.match(auth, /router\.post\('\/forgot-password'/);
  assert.match(auth, /router\.post\('\/password-reset\/complete'/);
  assert.match(auth, /listener_verification_status/);
  assert.match(sms, /FAST2SMS|fast2sms/i);
  assert.match(sms, /TWILIO|twilio/i);
  assert.match(auth, /router\.post\('\/support\/phone\/start'/);
  assert.match(auth, /router\.post\('\/support\/submit'/);
  assert.match(customer, /Let’s start/);
  assert.match(customer, /id="authProgressFill"/);
  assert.match(listener, /Your number stays private/);
  assert.match(listener, /Public username/);
  assert.match(listener, /Original name/);
  assert.doesNotMatch(listener, /type="email"/);
});

test('each listener membership is recurring ₹399 while every call remains wallet-only', () => {
  const config = read('backend', 'src', 'config.js');
  const subscriptions = read('backend', 'src', 'routes', 'subscriptions.js');
  const access = read('backend', 'src', 'subscription-access.js');
  const socket = read('backend', 'src', 'socket.js');
  const customer = read('customer-site', 'app.js');

  assert.match(config, /plan_TTIsGpwDtJmgi5/);
  assert.match(config, /subscriptionAmountPaise[^\n]*39900/);
  assert.match(config, /listenerSubscriptionCreditPaise[^\n]*5000/);
  assert.match(subscriptions, /razorpay\.subscriptions\.create/);
  assert.match(subscriptions, /plan_id: config\.razorpay\.subscriptionPlanId/);
  assert.match(subscriptions, /razorpay\.subscriptions\.cancel/);
  assert.match(subscriptions, /listener_credited_at/);
  assert.match(access, /status='active'/);
  assert.match(access, /listener_subscription_payments/);
  assert.match(access, /payment\.status='captured'/);
  assert.doesNotMatch(socket, /FROM listener_subscriptions/);
  assert.doesNotMatch(socket, /subscriptionRequired: true/);
  assert.match(socket, /const outcome = await ringCustomer\(user\.id, directEmployeeId/);
  assert.match(socket, /balance_seconds/);
  assert.match(customer, /Calls need only wallet talk-time/);
  assert.doesNotMatch(customer.slice(customer.indexOf('function requestCall'), customer.indexOf('function requestRandomCall')), /isSubscribed/);
  assert.match(customer, /selectTab\('wallet'\)/);
});

test('webhook uses the original raw body, signature verification and idempotent events', () => {
  const server = read('backend', 'server.js');
  const subscriptions = read('backend', 'src', 'routes', 'subscriptions.js');
  const schema = read('backend', 'database', 'schema.sql');

  assert.match(server, /\/api\/subscriptions\/webhook', express\.raw/);
  assert.ok(server.indexOf("/api/subscriptions/webhook', express.raw") < server.indexOf('app.use(express.json'));
  assert.match(subscriptions, /x-razorpay-signature/);
  assert.match(subscriptions, /crypto\.timingSafeEqual/);
  assert.match(subscriptions, /ON CONFLICT DO NOTHING RETURNING event_id/);
  assert.match(schema, /razorpay_webhook_events/);
  assert.match(schema, /uq_listener_wallet_subscription_credit/);
});

test('listener verification, private posts, followers and member messaging are end-to-end features', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const listenerRoutes = read('backend', 'src', 'routes', 'employee-social.js');
  const customerRoutes = read('backend', 'src', 'routes', 'customer-social.js');
  const adminRoutes = read('backend', 'src', 'routes', 'admin-social.js');
  const listenerHtml = read('employee-site', 'index.html');
  const adminHtml = read('admin-site', 'index.html');

  for (const table of ['listener_verifications', 'listener_posts', 'listener_follows', 'listener_subscriptions', 'direct_messages']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(listenerRoutes, /\/verification\/audio/);
  assert.match(listenerRoutes, /router\.post\('\/posts'/);
  assert.match(listenerRoutes, /router\.get\('\/followers'/);
  assert.match(listenerRoutes, /router\.post\('\/inbox\/:customerId\/messages'/);
  assert.match(customerRoutes, /requireActiveSubscription/);
  assert.match(adminRoutes, /router\.patch\('\/verifications\/:id'/);
  assert.match(adminRoutes, /router\.delete\('\/posts\/:id'/);
  assert.match(listenerHtml, /id="verificationView"/);
  assert.match(listenerHtml, /id="profileBannerEdit"/);
  assert.match(adminHtml, /id="page-verifications"/);
  assert.match(adminHtml, /id="page-content"/);
});

test('customer talk-time balance is presented only in the wallet page', () => {
  const html = read('customer-site', 'index.html');
  const walletStart = html.indexOf('id="tab-wallet"');
  const walletEnd = html.indexOf('id="tab-subscriptions"');
  assert.ok(walletStart > 0 && walletEnd > walletStart);
  const outsideWallet = html.slice(0, walletStart) + html.slice(walletEnd);
  assert.doesNotMatch(outsideWallet, /id="walletBalance"|minutes-balance/);
  assert.match(html.slice(walletStart, walletEnd), /id="walletBalance"/);
  assert.match(html.slice(walletStart, walletEnd), /Choose your minutes/);
});

test('v8.3 repairs legacy duplicate phone records before Render creates the unique index', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const repair = schema.indexOf('WITH ranked_phone_accounts AS');
  const uniqueIndex = schema.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_role_phone');
  assert.ok(repair > 0, 'duplicate-phone repair is missing');
  assert.ok(uniqueIndex > repair, 'duplicate-phone repair must run before the unique index');
  assert.match(schema.slice(repair, uniqueIndex), /ROW_NUMBER\(\) OVER/);
  assert.match(schema.slice(repair, uniqueIndex), /SET phone=NULL/);
  assert.doesNotMatch(schema.slice(repair, uniqueIndex), /DELETE FROM users/);
});

test('v8.3 customer home contains only connection, language choice and verified discovery', () => {
  const html = read('customer-site', 'index.html');
  const app = read('customer-site', 'app.js');
  const css = read('customer-site', 'style.css');
  const home = html.slice(html.indexOf('id="tab-home"'), html.indexOf('id="tab-wallet"'));

  assert.match(home, /id="randomConnectButton"/);
  assert.match(home, /id="otherLanguageToggle"/);
  assert.match(home, /id="listenerGrid"/);
  assert.doesNotMatch(html, /helloName|YOUR PRIVATE SPACE/);
  assert.match(app, /otherLanguageToggle'\)\.onchange = renderDirectory/);
  assert.match(app, /employeeId: null, allowOtherLanguages:/);
  assert.match(app, /async function openPayment/);
  assert.match(app, /new window\.Razorpay/);
  assert.match(app, /checkout\.open\(\)/);
  assert.doesNotMatch(app, /checkout\.html\?plan=|window\.open/);
  assert.doesNotMatch(html, /walletCheckoutSection/);
  assert.match(app, /theme: \{ color: '#e62d7d', backdrop_color: '#0c0d10' \}/);
  assert.match(css, /\.plans-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
  assert.match(css, /\.wallet-plan-card/);
});

test('v8.3 admin-created listeners are approved by default with an optional voice check', () => {
  const route = read('backend', 'src', 'routes', 'admin.js');
  const adminHtml = read('admin-site', 'index.html');
  const adminApp = read('admin-site', 'app.js');

  assert.match(route, /const requireVerification = req\.body\.requireVerification === true/);
  assert.match(route, /requireVerification \? 'voice_required' : 'approved'/);
  assert.match(route, /router\.patch\('\/employees\/:id\/verification'/);
  assert.match(adminHtml, /id="empRequireVerification" type="checkbox"/);
  assert.doesNotMatch(adminHtml, /id="empRequireVerification"[^>]*checked/);
  assert.match(adminApp, /requireVerification/);
});

test('listener portal uses app-style bottom navigation with no repeated greeting', () => {
  const html = read('employee-site', 'index.html');
  const app = read('employee-site', 'app.js');
  const deskStart = html.indexOf('id="tab-desk"');
  const postsStart = html.indexOf('id="tab-posts"');
  assert.ok(deskStart > 0 && postsStart > deskStart);
  assert.match(html.slice(deskStart, postsStart), /id="shiftStatus"/);
  assert.doesNotMatch(html.slice(0, deskStart), /id="shiftStatus"/);
  assert.match(html, /class="tabs listener-bottom-nav"/);
  assert.match(html, /data-tab="desk"[\s\S]*<span>Home<\/span>/);
  assert.match(html, /data-tab="inbox"[\s\S]*<span>Inbox<\/span>/);
  assert.match(html, /data-tab="posts"[\s\S]*<span>Create<\/span>/);
  assert.doesNotMatch(html, /YOUR LISTENER DESK|id="hello"/);
  assert.doesNotMatch(app, /\$\('#hello'\)/);
});

test('v8.3 listener withdrawals and administrator new/history queues are wired end to end', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const listenerRoute = read('backend', 'src', 'routes', 'employee.js');
  const adminRoute = read('backend', 'src', 'routes', 'admin.js');
  const listenerHtml = read('employee-site', 'index.html');
  const adminHtml = read('admin-site', 'index.html');
  const adminApp = read('admin-site', 'app.js');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS listener_withdrawal_requests/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS login_support_tickets/);
  assert.match(listenerRoute, /router\.post\('\/withdrawals'/);
  assert.match(listenerRoute, /Save your UPI ID/);
  assert.match(adminRoute, /router\.get\('\/withdrawals'/);
  assert.match(adminRoute, /router\.patch\('\/withdrawals\/:id'/);
  assert.match(adminRoute, /router\.get\('\/login-support'/);
  assert.match(listenerHtml, /id="withdrawalForm"/);
  assert.match(adminHtml, /id="page-withdrawals"/);
  assert.match(adminHtml, /data-queue-group="withdrawals"/);
  assert.match(adminApp, /const queueFilters = \{ verifications: 'new', withdrawals: 'new'/);
});

test('customer and listener social views plus Razorpay checkout stay inside their portals', () => {
  const customerHtml = read('customer-site', 'index.html');
  const customerApp = read('customer-site', 'app.js');
  const customerCss = read('customer-site', 'style.css');
  const listenerHtml = read('employee-site', 'index.html');
  const listenerApp = read('employee-site', 'app.js');
  const listenerCss = read('employee-site', 'style.css');

  const listenerProfile = customerApp.slice(
    customerApp.indexOf('async function openListenerProfile'),
    customerApp.indexOf('async function renderPrivatePosts'),
  );
  assert.match(listenerProfile, /listener-call-fab/);
  assert.doesNotMatch(listenerProfile, />Call now</);
  assert.doesNotMatch(listenerProfile, />Offline</);
  assert.match(listenerProfile, /status === 'available'/);

  const membershipCheckout = customerApp.slice(
    customerApp.indexOf('async function beginMembershipCheckout'),
    customerApp.indexOf('async function cancelSubscription'),
  );
  const walletCheckout = customerApp.slice(
    customerApp.indexOf('async function openPayment'),
    customerApp.indexOf('async function redeemCoupon'),
  );
  for (const checkout of [walletCheckout, membershipCheckout]) {
    assert.match(checkout, /\/shared\/icon-192\.png/);
    assert.match(checkout, /redirect: false/);
    assert.match(checkout, /backdrop_color: '#0c0d10'/);
    assert.match(checkout, /checkout\.open\(\)/);
  }
  assert.doesNotMatch(walletCheckout, /window\.open|target=['"]_blank/);
  assert.doesNotMatch(walletCheckout, /location\.(?:assign|replace)|window\.location/);
  assert.doesNotMatch(membershipCheckout, /show\('#membershipCheckoutModal', false\)/);

  const customerProfile = customerHtml.slice(
    customerHtml.indexOf('id="tab-profile"'),
    customerHtml.indexOf('id="authModal"'),
  );
  assert.equal((customerProfile.match(/data-jump="following"/g) || []).length, 1);
  assert.match(customerApp, /async function chooseCustomerPhoto/);
  assert.match(customerApp, /Profile photo updated\./);
  assert.match(customerCss, /\.plans-grid\{width:min\(880px,100%\);grid-template-columns:repeat\(3/);
  assert.match(customerCss, /@media\(max-width:760px\)[\s\S]*\.plans-grid\{grid-template-columns:repeat\(2/);
  assert.match(customerCss, /\.direct-message-layout\.no-conversations \.direct-chat\{display:none\}/);

  assert.match(listenerHtml, /id="profileBannerEdit"/);
  assert.match(listenerHtml, /id="profilePhotoFile"/);
  assert.doesNotMatch(listenerHtml, /id="profileMediaChoices"|id="showAvatarChoices"|>Choose from gallery<|>Choose avatar<|>Change banner</);
  assert.match(listenerApp, /async function saveProfileMedia/);
  assert.match(listenerApp, /saveProfileMedia\('profileImage'/);
  assert.match(listenerApp, /saveProfileMedia\('bannerImage'/);
  assert.match(listenerCss, /\.app-profile\{min-height:0!important;padding:0 0 20px!important/);
  assert.match(listenerCss, /\.follower-count\{min-width:0;padding:0;border:0;border-radius:0;background:transparent/);
  assert.match(customerHtml, /id="customerPostFeed"/);
  assert.match(customerCss, /\.customer-post-feed-list/);
  assert.match(listenerHtml, /id="listenerPostLikesSheet"/);
  assert.match(listenerApp, /async function openPostLikers/);
  assert.match(listenerApp, /listener-post-options/);
  assert.match(listenerApp, /data-edit-post/);
});

test('v8.4 keeps pre-ring searches invisible and exposes listener-only post insights', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const socket = read('backend', 'src', 'socket.js');
  const customerRoutes = read('backend', 'src', 'routes', 'customer-social.js');
  const listenerRoutes = read('backend', 'src', 'routes', 'employee-social.js');
  const customerApp = read('customer-site', 'app.js');
  const listenerApp = read('employee-site', 'app.js');
  const listenerHtml = read('employee-site', 'index.html');

  const randomCall = customerApp.slice(
    customerApp.indexOf('function requestRandomCall'),
    customerApp.indexOf('function syncCallRequestControls'),
  );
  assert.doesNotMatch(randomCall, /openCall\(\)|currentCall\s*=/);
  assert.match(customerApp, /socket\.on\('call:ringing'[\s\S]*openCall\(\)/);
  assert.match(customerApp, /socket\.timeout\(12_000\)\.emit\('call:request'/);
  assert.match(customerApp, /if \(!liveDirectoryReady \|\| !socket\?\.connected\) return 'offline'/);
  assert.match(customerApp, /liveDirectoryReady = true;[\s\S]{0,500}renderDirectory\(\)/);
  assert.match(socket, /availabilityReply\(acknowledge, outcome/);
  assert.match(socket, /return preferred \? preferredEmployeeId : null/);
  assert.match(socket, /runtime\.status !== 'ringing' \|\| runtime\.ending \|\| runtime\.accepting/);
  assert.match(socket, /if \(!hasLiveSocket\(user\.id\) \|\| user\.listener_availability !== 'online'\)/);
  const incomingDispatch = socket.indexOf("emitToUser(employeeId, 'call:incoming'");
  const customerRingingDispatch = socket.indexOf("emitToUser(customerId, 'call:ringing'");
  assert.ok(incomingDispatch >= 0 && incomingDispatch < customerRingingDispatch);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS listener_post_likes/);
  assert.match(customerRoutes, /\/listener-posts\/:postId\/like/);
  assert.match(listenerRoutes, /\/posts\/:id\/insights/);
  assert.match(listenerRoutes, /router\.patch\('\/posts\/:id'/);
  assert.match(listenerHtml, /id="listenerPostDetailModal"/);
  assert.match(listenerHtml, /id="listenerPostEditModal"/);
  assert.match(listenerApp, /function openPostInsights/);
  assert.match(listenerApp, /async function openPostEditor/);
  assert.match(listenerApp, /async function savePostEdit/);
});

test('v8.7 keeps listener media fresh, shares assets and launches Standard Checkout directly', () => {
  const publicRoutes = read('backend', 'src', 'routes', 'public.js');
  const socket = read('backend', 'src', 'socket.js');
  const customerApp = read('customer-site', 'app.js');
  const customerCss = read('customer-site', 'style.css');
  const listenerApp = read('employee-site', 'app.js');
  const listenerCss = read('employee-site', 'style.css');
  const customerHeaders = read('customer-site', '_headers');

  assert.match(publicRoutes, /Cache-Control', 'no-store, max-age=0'/);
  assert.match(customerApp, /\/shared\/default-listener-banner\.png/);
  assert.match(listenerApp, /\/shared\/default-listener-banner\.png/);
  assert.match(listenerApp, /profileMediaVersion = Date\.now\(\)/);
  assert.match(socket, /io\.emit\('listener:profile-updated'/);
  assert.match(customerApp, /socket\.on\('listener:profile-updated'/);
  assert.match(customerApp, /async function openPayment/);
  assert.match(customerApp, /new window\.Razorpay/);
  assert.match(customerApp, /redirect: false/);
  assert.match(customerApp, /handleback: true/);
  assert.doesNotMatch(customerApp, /checkout\.html|short_url|window\.location\.assign/);
  assert.match(listenerCss, /\.listener-profile-editor\.hidden\{display:none!important\}/);
  assert.match(customerHeaders, /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.match(customerHeaders, /frame-src https:\/\/api\.razorpay\.com https:\/\/checkout\.razorpay\.com/);
  assert.equal(fs.existsSync(path.join(root, 'shared', 'default-listener-banner.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'customer-site', 'checkout.html')), false);
});
}
