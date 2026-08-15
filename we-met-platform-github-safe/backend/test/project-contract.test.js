const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (/\.(?:js|json|html|css|xml|txt|yaml|yml|webmanifest)$/.test(entry.name)) files.push(target);
  }
  return files;
}

test('keeps the retired payment provider out of production source and dependencies', () => {
  const retiredName = ['razor', 'pay'].join('');
  const matches = sourceFiles(projectRoot).filter((file) => read(path.relative(projectRoot, file)).toLowerCase().includes(retiredName));
  assert.deepEqual(matches, []);
  const packageJson = JSON.parse(read('backend', 'package.json'));
  assert.equal(packageJson.dependencies[retiredName], undefined);
});

test('keeps talk-time plans behind customer authentication', () => {
  const publicRoutes = read('backend', 'src', 'routes', 'public.js');
  const customerRoutes = read('backend', 'src', 'routes', 'customer.js');
  const landing = read('legacy-web', 'customer-site', 'index.html').split('<section id="dashboard"')[0];
  assert.doesNotMatch(publicRoutes, /router\.get\(['"]\/plans/);
  assert.match(customerRoutes, /router\.get\(['"]\/plans/);
  assert.doesNotMatch(landing, /id="plansGrid"|class="plans-grid"/);
});

test('keeps listener work-session analytics private to admin while listener sees talk-time only', () => {
  assert.match(read('backend', 'database', 'schema.sql'), /listener_activity_sessions/);
  assert.match(read('backend', 'src', 'routes', 'employee.js'), /router\.get\(['"]\/activity/);
  assert.match(read('backend', 'src', 'routes', 'admin.js'), /today_work_seconds/);
  assert.doesNotMatch(read('legacy-web', 'employee-site', 'index.html'), /id="(?:todayWork|weekWork|todayBreak)"/);
  assert.match(read('legacy-web', 'employee-site', 'index.html'), /id="weekTime"/);
  assert.match(read('legacy-web', 'employee-site', 'index.html'), /id="activityList"/);
  assert.match(read('legacy-web', 'admin-site', 'index.html'), /id="listenerTodayWork"/);
  assert.match(read('backend', 'src', 'socket.js'), /currentRuntime\s*\?\s*\(currentRuntime\.status === 'ringing' \? 'ringing' : 'busy'\)/);
});

test('ships listener earnings, individual rates, exact payouts and immutable wallet history', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const adminRoutes = read('backend', 'src', 'routes', 'admin.js');
  const employeeRoutes = read('backend', 'src', 'routes', 'employee.js');
  const nativeAdmin = read('admin-app', 'src', 'main', 'java', 'com', 'quartzwebsolutions', 'wemet', 'admin', 'MainActivity.kt');
  const listenerHtml = read('legacy-web', 'employee-site', 'index.html');
  const adminHtml = read('legacy-web', 'admin-site', 'index.html');
  assert.match(schema, /listener_wallet_transactions/);
  assert.match(schema, /uq_listener_wallet_call_credit/);
  assert.match(schema, /uq_listener_wallet_payout_idempotency/);
  assert.match(schema, /idempotency_key/);
  assert.match(schema, /listener_rate_paise/);
  assert.match(schema, /IF NOT earnings_column_exists THEN/);
  assert.doesNotMatch(schema, /WHERE earnings_settled_at IS NULL\s+AND status IN/);
  assert.match(adminRoutes, /\/listener-wallets\/:id\/mark-paid/);
  assert.match(adminRoutes, /FOR UPDATE/);
  assert.match(adminRoutes, /settleCompletedCallsBeforePayout/);
  assert.match(adminRoutes, /earnings_settled_at IS NULL/);
  assert.match(adminRoutes, /alreadyProcessed/);
  assert.match(adminRoutes, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(adminRoutes, /Call settlement always locks call -> listener/);
  assert.match(nativeAdmin, /UUID\.randomUUID\(\)/);
  assert.match(nativeAdmin, /permanent payout ledger entry/);
  assert.match(employeeRoutes, /router\.get\(['"]\/wallet/);
  assert.match(employeeRoutes, /\/wallet\/payout-details/);
  assert.match(listenerHtml, /id="tab-wallet"/);
  assert.match(listenerHtml, /id="walletBalance"/);
  assert.match(adminHtml, /id="page-payouts"/);
  assert.match(adminHtml, /id="payoutDueTotal"/);
});

test('native WebRTC pauses billing and recovers signaling across brief network changes', () => {
  const callEngine = read('call-core', 'src', 'main', 'java', 'com', 'quartzwebsolutions', 'wemet', 'core', 'call', 'WebRtcAudioCall.kt');
  const socket = read('backend', 'src', 'socket.js');
  assert.match(callEngine, /pendingRemoteCandidates/);
  assert.match(callEngine, /reportMediaState\(false\)/);
  assert.match(callEngine, /restartIce\(\)/);
  assert.match(callEngine, /AudioFocusRequest/);
  assert.match(socket, /call:resumed/);
  assert.match(socket, /updateMediaState\(runtime, user\.id, false\)/);
});

test('provides full clickable admin profiles and administrator audit history', () => {
  const adminApp = read('legacy-web', 'admin-site', 'app.js');
  assert.match(adminApp, /data-user-profile/);
  assert.match(adminApp, /\/api\/admin\/users\/\$\{id\}\/details/);
  assert.match(adminApp, /activitySessions/);
  assert.match(adminApp, /\/api\/admin\/audit-log/);
  assert.match(read('legacy-web', 'admin-site', 'index.html'), /id="page-audit"/);
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

test('supports customer reporting and blocking for one-to-one interactions', () => {
  const schema = read('backend', 'database', 'schema.sql');
  const customerRoutes = read('backend', 'src', 'routes', 'customer.js');
  const socket = read('backend', 'src', 'socket.js');
  const customerApp = read('customer-app', 'src', 'main', 'java', 'com', 'quartzwebsolutions', 'wemet', 'MainActivity.kt');
  assert.match(schema, /customer_listener_blocks/);
  assert.match(customerRoutes, /router\.post\('\/blocks\/:employeeId'/);
  assert.match(customerRoutes, /router\.delete\('\/blocks\/:employeeId'/);
  assert.match(socket, /SELECT employee_id FROM customer_listener_blocks WHERE customer_id=\$1/);
  assert.match(customerApp, /Block listener/);
  assert.match(customerApp, /End and report conversation/);
});

test('includes public company, contact, safety and policy pages', () => {
  for (const name of ['about.html', 'contact.html', 'terms.html', 'privacy.html', 'refund.html', 'safety.html', 'child-safety.html', 'delete-account.html', 'robots.txt', 'sitemap.xml']) {
    assert.equal(fs.existsSync(path.join(projectRoot, 'legacy-web', 'customer-site', name)), true, `${name} is missing`);
  }
});

test('uses unique element ids in each primary interface', () => {
  for (const site of ['customer-site', 'admin-site', 'employee-site']) {
    const html = read('legacy-web', site, 'index.html');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], `${site} contains duplicate ids`);
  }
});
