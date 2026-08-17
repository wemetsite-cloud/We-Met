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
  const landing = read('customer-site', 'index.html').split('<section id="dashboard"')[0];
  assert.doesNotMatch(publicRoutes, /router\.get\(['"]\/plans/);
  assert.match(customerRoutes, /router\.get\(['"]\/plans/);
  assert.doesNotMatch(landing, /id="plansGrid"|class="plans-grid"/);
});

test('ships listener work-session tracking across database, API and both staff interfaces', () => {
  assert.match(read('backend', 'database', 'schema.sql'), /listener_activity_sessions/);
  assert.match(read('backend', 'src', 'routes', 'employee.js'), /router\.get\(['"]\/activity/);
  assert.match(read('backend', 'src', 'routes', 'admin.js'), /today_work_seconds/);
  assert.match(read('employee-site', 'index.html'), /id="todayWork"/);
  assert.match(read('employee-site', 'index.html'), /id="activityList"/);
  assert.match(read('admin-site', 'index.html'), /id="listenerTodayWork"/);
  assert.match(read('backend', 'src', 'socket.js'), /currentRuntime\s*\?\s*\(currentRuntime\.status === 'ringing' \? 'ringing' : 'busy'\)/);
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


test('ships the configured Paytm UPI destination and 240-minute ₹1999 plan', () => {
  const render = read('render.yaml');
  const schema = read('backend', 'database', 'schema.sql');
  assert.match(render, /UPI_PAYMENT_ID[\s\S]*paytm\.s3hc53w@pty/);
  assert.match(schema, /\('Long Connect',199900,14400,false,true,60\)/);
});
