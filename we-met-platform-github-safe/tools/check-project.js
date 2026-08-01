const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git']);
const jsFiles = [];
const htmlFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
    else if (entry.name.endsWith('.html')) htmlFiles.push(full);
  }
}
walk(root);

let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax error: ${path.relative(root, file)}\n${result.stderr}`);
  }
}

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) {
    failed = true;
    console.error(`Duplicate HTML ids in ${path.relative(root, htmlFile)}: ${[...new Set(duplicates)].join(', ')}`);
  }

  const appFile = path.join(path.dirname(htmlFile), 'app.js');
  if (fs.existsSync(appFile)) {
    const js = fs.readFileSync(appFile, 'utf8');
    const selectors = [...js.matchAll(/\$\(["'](#[A-Za-z][\w:-]*)["']\)/g)].map((m) => m[1].slice(1));
    const dynamicIds = [...js.matchAll(/\bid=[\\"']([A-Za-z][\w:-]*)[\\"']/g)].map((m) => m[1]);
    const available = new Set([...ids, ...dynamicIds]);
    const missing = [...new Set(selectors.filter((id) => !available.has(id)))];
    if (missing.length) {
      failed = true;
      console.error(`Missing HTML ids for ${path.relative(root, appFile)}: ${missing.join(', ')}`);
    }
  }
}

const required = [
  'customer-site/style.css', 'employee-site/style.css', 'admin-site/style.css',
  'customer-site/assets/logo.svg', 'employee-site/assets/logo.svg', 'admin-site/assets/logo.svg',
  'customer-site/manifest.webmanifest', 'employee-site/manifest.webmanifest', 'admin-site/manifest.webmanifest',
  'customer-site/service-worker.js', 'employee-site/service-worker.js', 'admin-site/service-worker.js',
  'backend/.env.example', 'backend/database/schema.sql', 'SETUP_WINDOWS.bat', 'START_WINDOWS.bat',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) {
    failed = true;
    console.error(`Missing required file: ${relative}`);
  }
}

for (const portal of ['customer-site', 'employee-site', 'admin-site']) {
  const manifestPath = path.join(root, portal, 'manifest.webmanifest');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.display !== 'standalone' || !manifest.start_url || !Array.isArray(manifest.icons) || manifest.icons.length < 2) {
      throw new Error('missing standalone/start_url/icons');
    }
  } catch (error) {
    failed = true;
    console.error(`Invalid PWA manifest: ${portal}/manifest.webmanifest (${error.message})`);
  }
}

const schema = fs.readFileSync(path.join(root, 'backend/database/schema.sql'), 'utf8');
for (const table of ['call_messages', 'password_reset_requests', 'payment_submissions', 'wallet_transactions']) {
  if (!schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) {
    failed = true;
    console.error(`Database schema is missing required table: ${table}`);
  }
}

const workflowSources = {
  socket: fs.readFileSync(path.join(root, 'backend/src/socket.js'), 'utf8'),
  admin: fs.readFileSync(path.join(root, 'backend/src/routes/admin.js'), 'utf8'),
  customer: fs.readFileSync(path.join(root, 'backend/src/routes/customer.js'), 'utf8'),
  auth: fs.readFileSync(path.join(root, 'backend/src/routes/auth.js'), 'utf8'),
  public: fs.readFileSync(path.join(root, 'backend/src/routes/public.js'), 'utf8'),
  customerUi: fs.readFileSync(path.join(root, 'customer-site/app.js'), 'utf8'),
};
const invariants = [
  [workflowSources.socket.includes("socket.on('chat:send'") && workflowSources.socket.includes('callId,\n          senderId'), 'Chat messages must include callId and delivery acknowledgement.'],
  [workflowSources.admin.includes('SELECT * FROM payment_submissions WHERE id=$1 FOR UPDATE') && workflowSources.admin.includes("record.status !== 'pending'"), 'Payment approval must lock and accept only pending records.'],
  [schema.includes('uq_wallet_payment_credit') && schema.includes("type='payment'"), 'Payment credits must be idempotent in the wallet ledger.'],
  [workflowSources.customer.includes('validImageBytes') && workflowSources.customer.includes('5 * 1024 * 1024'), 'Payment screenshot validation and size limits are required.'],
  [workflowSources.auth.includes('recovery_key_hash') && workflowSources.auth.includes("request.status !== 'approved'"), 'Password recovery must require the private key and administrator approval.'],
  [workflowSources.public.includes('QRCode.toDataURL') && workflowSources.public.includes('googlePayUrl') && workflowSources.public.includes('upiUrl'), 'Checkout must provide exact UPI, Google Pay and QR payment options.'],
  [workflowSources.customerUi.includes('previewPaymentProof') && workflowSources.customerUi.includes('startPaymentPolling'), 'Customer checkout must preview proof and refresh administrator approval status.'],
];
for (const [valid, message] of invariants) {
  if (!valid) {
    failed = true;
    console.error(message);
  }
}

if (failed) process.exit(1);
console.log(`Project check passed: ${jsFiles.length} JavaScript files and ${htmlFiles.length} HTML files.`);
