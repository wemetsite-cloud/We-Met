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
  assert.match(socket, /ringCustomer\(user\.id, employeeId \|\| null/);
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
  assert.match(app, /walletCheckoutModal/);
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

test('v8.3 screenshot regressions keep calls, profiles, messages and checkout in the intended UI', () => {
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

  const walletCheckout = customerApp.slice(
    customerApp.indexOf('async function beginWalletCheckout'),
    customerApp.indexOf('async function redeem'),
  );
  const membershipCheckout = customerApp.slice(
    customerApp.indexOf('async function beginMembershipCheckout'),
    customerApp.indexOf('async function cancelSubscription'),
  );
  for (const checkout of [walletCheckout, membershipCheckout]) {
    assert.match(checkout, /assets\/icon-192\.png/);
    assert.match(checkout, /redirect: false/);
    assert.match(checkout, /backdrop_color: '#0c0d10'/);
  }
  assert.doesNotMatch(walletCheckout, /show\('#walletCheckoutModal', false\)/);
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
});
