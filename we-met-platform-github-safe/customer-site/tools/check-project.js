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
  'customer-site/_headers', 'employee-site/_headers', 'admin-site/_headers',
  'customer-site/assets/logo.svg', 'employee-site/assets/logo.svg', 'admin-site/assets/logo.svg',
  'customer-site/manifest.webmanifest', 'employee-site/manifest.webmanifest', 'admin-site/manifest.webmanifest',
  'customer-site/service-worker.js', 'employee-site/service-worker.js', 'admin-site/service-worker.js',
  'backend/.env.example', 'backend/database/schema.sql',
  'backend/src/push.js', 'backend/src/routes/push.js', 'backend/scripts/generate-vapid-keys.js',
  'backend/src/manual-payment.js', 'backend/src/routes/manual-payments.js',
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

  const serviceWorker = fs.readFileSync(path.join(root, portal, 'service-worker.js'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(root, portal, 'index.html'), 'utf8');
  const portalApp = fs.readFileSync(path.join(root, portal, 'app.js'), 'utf8');
  if (!serviceWorker.includes("const VERSION = '5.13.0'") || !serviceWorker.includes("cache: 'no-store'")) {
    failed = true;
    console.error(`Stale-cache protection is missing from ${portal}/service-worker.js`);
  }
  if (!portalHtml.includes('?v=5.13.0') || !portalApp.includes("updateViaCache: 'none'")) {
    failed = true;
    console.error(`Current cache-busting registration is missing from ${portal}`);
  }
}

const schema = fs.readFileSync(path.join(root, 'backend/database/schema.sql'), 'utf8');
for (const table of ['call_messages', 'password_reset_requests', 'manual_payment_intents', 'payment_submissions', 'wallet_transactions', 'razorpay_orders', 'razorpay_webhook_events', 'push_subscriptions']) {
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
  razorpay: fs.readFileSync(path.join(root, 'backend/src/routes/razorpay.js'), 'utf8'),
  razorpayWebhook: fs.readFileSync(path.join(root, 'backend/src/routes/razorpay-webhook.js'), 'utf8'),
  razorpayCredit: fs.readFileSync(path.join(root, 'backend/src/razorpay-credit.js'), 'utf8'),
  manualPayments: fs.readFileSync(path.join(root, 'backend/src/routes/manual-payments.js'), 'utf8'),
  manualPaymentService: fs.readFileSync(path.join(root, 'backend/src/manual-payment.js'), 'utf8'),
  server: fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8'),
  customerUi: fs.readFileSync(path.join(root, 'customer-site/app.js'), 'utf8'),
  customerHtml: fs.readFileSync(path.join(root, 'customer-site/index.html'), 'utf8'),
  customerCss: fs.readFileSync(path.join(root, 'customer-site/style.css'), 'utf8'),
  adminUi: fs.readFileSync(path.join(root, 'admin-site/app.js'), 'utf8'),
  adminHtml: fs.readFileSync(path.join(root, 'admin-site/index.html'), 'utf8'),
  adminCss: fs.readFileSync(path.join(root, 'admin-site/style.css'), 'utf8'),
  employeeUi: fs.readFileSync(path.join(root, 'employee-site/app.js'), 'utf8'),
  employeeHtml: fs.readFileSync(path.join(root, 'employee-site/index.html'), 'utf8'),
  customerWorker: fs.readFileSync(path.join(root, 'customer-site/service-worker.js'), 'utf8'),
  employeeWorker: fs.readFileSync(path.join(root, 'employee-site/service-worker.js'), 'utf8'),
  push: fs.readFileSync(path.join(root, 'backend/src/push.js'), 'utf8'),
  pushRoute: fs.readFileSync(path.join(root, 'backend/src/routes/push.js'), 'utf8'),
  backendPackage: fs.readFileSync(path.join(root, 'backend/package.json'), 'utf8'),
};
const invariants = [
  [workflowSources.socket.includes("socket.on('chat:send'") && workflowSources.socket.includes('callId,\n          senderId'), 'Chat messages must include callId and delivery acknowledgement.'],
  [workflowSources.admin.includes('SELECT * FROM payment_submissions WHERE id=$1 FOR UPDATE') && workflowSources.admin.includes("record.status !== 'pending'"), 'Payment approval must lock and accept only pending records.'],
  [schema.includes('uq_wallet_payment_credit') && schema.includes('razorpay_orders') && workflowSources.razorpayCredit.includes('ON CONFLICT DO NOTHING'), 'Razorpay wallet credits must be transactionally idempotent.'],
  [workflowSources.razorpay.includes('gateway.createOrder') && workflowSources.razorpay.includes('gateway.verifyPaymentSignature') && workflowSources.razorpay.includes('gateway.fetchPayment'), 'Razorpay orders, Checkout signatures and captured status must be verified on the server.'],
  [workflowSources.razorpayWebhook.includes('verifyWebhookSignature') && workflowSources.server.includes("express.raw({ type: 'application/json'") && schema.includes('razorpay_webhook_events'), 'Razorpay webhooks must use the raw signed body and idempotent event storage.'],
  [workflowSources.auth.includes('recovery_key_hash') && workflowSources.auth.includes("request.status !== 'approved'"), 'Password recovery must require the private key and administrator approval.'],
  [workflowSources.customerUi.includes('checkout.razorpay.com/v1/checkout.js') && workflowSources.customerUi.includes('startRazorpayCheckout') && workflowSources.customerUi.includes('ensureRazorpayCheckout'), 'Razorpay mode must load Standard Checkout only when it is used.'],
  [workflowSources.customerUi.includes('/api/customer/razorpay/verify') && workflowSources.customerUi.includes('startPaymentPolling'), 'Customer checkout must send the success signature to the backend and refresh payment status.'],
  [!workflowSources.auth.includes('dateOfBirth') && workflowSources.auth.includes('at least 18') && !workflowSources.customerHtml.includes('regDob') && workflowSources.customerHtml.includes('I am at least 18'), 'Registration must use the 18+ confirmation without a date-of-birth field.'],
  [workflowSources.customerCss.includes('grid-template-columns:repeat(2,minmax(0,1fr))') && workflowSources.customerCss.includes('grid-template-columns:repeat(3,minmax(0,1fr))') && workflowSources.customerCss.includes('grid-template-columns:repeat(4,minmax(0,1fr))'), 'Talk-time packs must use responsive two, three and four-column layouts.'],
  [workflowSources.socket.includes('concurrentUsers') && workflowSources.socket.includes('onlineByRole') && workflowSources.adminUi.includes("$('#mConcurrent')") && workflowSources.adminHtml.includes('People online now'), 'Admin concurrent-presence reporting is required.'],
  [workflowSources.adminHtml.includes('customer-directory-grid') && workflowSources.adminCss.includes('.customer-card') && workflowSources.adminCss.includes('grid-template-columns:repeat(auto-fit,minmax(330px,1fr))'), 'Customer directory must use responsive professional cards on mobile and desktop.'],
  [workflowSources.customerUi.includes('history.pushState') && workflowSources.customerUi.includes("window.addEventListener('popstate'") && workflowSources.customerHtml.includes('id="appBackButton"'), 'Customer screens and overlays must use in-app Back history.'],
  [workflowSources.employeeUi.includes('history.pushState') && workflowSources.employeeUi.includes("window.addEventListener('popstate'") && workflowSources.employeeHtml.includes('id="listenerBackButton"'), 'Listener screens and calls must use in-app Back history.'],
  [workflowSources.adminUi.includes('customer_phone') && workflowSources.adminUi.includes('phone-link') && workflowSources.adminHtml.includes('id="customerPhoneCount"'), 'Admin customer and payment views must expose private phone records only in the responsive admin directory.'],
  [workflowSources.auth.includes('normalisePhone') && workflowSources.auth.includes("router.post('/change-phone'") && workflowSources.customerHtml.includes('id="regPhone"') && workflowSources.customerHtml.includes('id="profilePhone"'), 'Customer phone capture and password-confirmed updates are required.'],
  [schema.includes('push_subscriptions') && workflowSources.server.includes("app.use('/api/push'") && workflowSources.push.includes('webPush.sendNotification') && workflowSources.pushRoute.includes("router.post('/subscriptions'"), 'Authenticated Web Push subscriptions and server delivery are required.'],
  [workflowSources.socket.includes('pushService?.sendToUser') && workflowSources.employeeWorker.includes("addEventListener('push'") && workflowSources.employeeWorker.includes("addEventListener('notificationclick'"), 'Listener incoming calls must reach the notification bar and reopen the PWA.'],
  [schema.includes('listener_availability') && workflowSources.socket.includes('hydratePersistentEmployees') && workflowSources.socket.includes("listener_availability='online'") && workflowSources.socket.includes("runtime?.status === 'ringing'") && workflowSources.employeeUi.includes('Enable notification permission before going online.'), 'Listener availability must persist after the site closes and reconnect a pending pushed call.'],
  [workflowSources.socket.includes("title: customer.name") && workflowSources.socket.includes("body: 'is calling you'") && workflowSources.socket.includes('silent: true') && workflowSources.employeeWorker.includes('silent: data.silent === true'), 'Background listener call notifications must be silent and show only the caller name with a simple calling message.'],
  [workflowSources.customerWorker.includes("addEventListener('push'") && workflowSources.customerUi.includes('paymentEnableAlerts'), 'Customer payment alerts must support opt-in Web Push.'],
  [workflowSources.server.includes("app.use('/api/customer/manual-payments'") && schema.includes('manual_payment_intents') && workflowSources.manualPayments.includes("router.post('/intents'") && workflowSources.manualPayments.includes("router.post('/submissions'"), 'Direct transfers must use authenticated server-priced intents and a dedicated submission route.'],
  [workflowSources.manualPayments.includes('pg_advisory_xact_lock') && workflowSources.manualPayments.includes('detectImageMime') && workflowSources.manualPayments.includes('MAX_PROOF_BYTES') && workflowSources.manualPayments.includes('if (!req.file)') && workflowSources.customerHtml.includes('id="manualProof"') && workflowSources.customerHtml.includes('required') && schema.includes('uq_wallet_payment_credit'), 'UTRs, required screenshots and wallet credits must be protected against duplicates and unsafe uploads.'],
  [workflowSources.manualPaymentService.includes('upiPaymentUri') && workflowSources.manualPaymentService.includes('encodeURIComponent') && workflowSources.manualPayments.includes('QRCode.toDataURL(qrPayload') && workflowSources.manualPayments.includes('upi_qr_data_url'), 'The backend must generate an exact-amount, percent-safe UPI QR without exposing a payment-app redirect.'],
  [!workflowSources.manualPaymentService.includes('googlePayUri') && !workflowSources.manualPaymentService.includes('androidGooglePayUri') && !workflowSources.manualPayments.includes('google_pay_uri') && !workflowSources.manualPayments.includes('google_pay_android_uri'), 'Payment-app-specific redirect URLs must not be generated or returned.'],
  [workflowSources.customerUi.includes('/api/customer/manual-payments/intents') && workflowSources.customerUi.includes('/api/customer/manual-payments/submissions') && workflowSources.customerUi.includes('saveUpiQr') && !workflowSources.customerUi.includes('launchUpiApp') && workflowSources.customerHtml.includes('id="manualUpiQr"') && workflowSources.customerHtml.includes('id="manualUpiId"') && workflowSources.customerHtml.includes('id="downloadUpiQr"') && workflowSources.customerHtml.includes('class="simple-upi-layout"') && workflowSources.customerCss.includes('.simple-upi-mode .payment-progress{display:none}') && !workflowSources.customerHtml.includes('id="manualCheckoutReference"') && !workflowSources.customerHtml.includes('id="manualGooglePayLink"') && !workflowSources.customerHtml.includes('id="manualAccountNumber"'), 'Customer checkout must open as a lightweight QR-first view with no visible checkout reference, app redirect or bank-account form.'],
  [workflowSources.customerHtml.includes('id="appBackButton"') && workflowSources.employeeHtml.includes('id="listenerBackButton"') && workflowSources.adminHtml.includes('id="adminBackButton"') && !workflowSources.customerHtml.includes('<b>Back</b>') && !workflowSources.employeeHtml.includes('<b>Back</b>') && !workflowSources.adminHtml.includes('<b>Back</b>'), 'Top navigation must use accessible icon-only Back buttons across every portal.'],
  [workflowSources.adminCss.includes('Rose control centre, icon navigation and responsive workspace') && workflowSources.adminCss.includes('grid-template-columns:repeat(auto-fit,minmax(280px,1fr))') && workflowSources.adminCss.includes('max-height:calc(100dvh - 122px)'), 'The admin workspace must retain its rose responsive card, form and scrolling polish.'],
  [!workflowSources.admin.includes('settlementRecordMatched') && !workflowSources.adminUi.includes('UPI APP or BANK STATEMENT') && workflowSources.admin.includes("record.status !== 'pending'") && workflowSources.admin.includes('record.proof_data') && workflowSources.admin.includes('record.utr_reference') && workflowSources.adminUi.includes('data-payment-approve'), 'Admin approval must use the submitted screenshot and UTR without an extra settlement-match field, while still requiring pending state and duplicate protection.'],
  [!workflowSources.public.includes('payment-checkout') && !workflowSources.customer.includes("router.post('/payments'") && workflowSources.backendPackage.includes('qrcode') && workflowSources.backendPackage.includes('multer'), 'Only the protected QR/UTR flow may expose direct UPI checkout.'],
];
for (const [valid, message] of invariants) {
  if (!valid) {
    failed = true;
    console.error(message);
  }
}

if (failed) process.exit(1);
console.log(`Project check passed: ${jsFiles.length} JavaScript files and ${htmlFiles.length} HTML files.`);
