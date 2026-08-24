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
  assert.match(auth, /listener_verification_status/);
  assert.match(sms, /FAST2SMS|fast2sms/i);
  assert.match(customer, /Let’s start/);
  assert.match(customer, /id="authProgressFill"/);
  assert.match(listener, /Your number is fully safe/);
  assert.match(listener, /Public username/);
  assert.match(listener, /Original name/);
  assert.doesNotMatch(listener, /type="email"/);
});

test('each listener membership is recurring ₹399 and keeps paid calls separate', () => {
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
  assert.match(socket, /FROM listener_subscriptions/);
  assert.match(socket, /subscriptionRequired: true/);
  assert.match(socket, /balance_seconds/);
  assert.match(customer, /Membership does not include free calls/);
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
  assert.match(listenerHtml, /id="profileUploadBanner"/);
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
