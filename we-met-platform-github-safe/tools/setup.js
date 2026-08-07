const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const examplePath = path.join(root, 'backend', '.env.example');
const envPath = path.join(root, 'backend', '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));

let muteInput = false;
const originalWrite = rl._writeToOutput.bind(rl);
rl._writeToOutput = (value) => {
  if (!muteInput) return originalWrite(value);
  // Keep passwords out of the console while still giving visual typing feedback.
  if (value === '\r\n' || value === '\n' || value === '\r') return originalWrite(value);
  return originalWrite('*');
};

const askHidden = (question) => new Promise((resolve) => {
  process.stdout.write(question);
  muteInput = true;
  rl.question('', (answer) => {
    muteInput = false;
    process.stdout.write('\n');
    resolve(answer.trim());
  });
});

function replaceLine(text, key, value) {
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, 'm');
  return expression.test(text) ? text.replace(expression, line) : `${text.trimEnd()}\n${line}\n`;
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

async function askPassword(label) {
  while (true) {
    const value = await askHidden(`${label} (minimum 10 characters): `);
    if (value.length < 10) {
      console.log('Password is too short. Use at least 10 characters.');
      continue;
    }
    const confirmation = await askHidden(`Type the same ${label.toLowerCase()} again: `);
    if (value !== confirmation) {
      console.log('Passwords did not match. Try again.');
      continue;
    }
    return value;
  }
}

(async () => {
  console.log('\nWE MET V5.11 — SAFE LOCAL SETUP\n');
  console.log('This creates backend\\.env only on this computer.');
  console.log('Never upload backend\\.env or share your database/password values.\n');
  console.log('Open Supabase > Connect > Session pooler > URI and copy the full URI.\n');

  let uri = await ask('Paste the complete Session Pooler URI: ');
  if (!uri.startsWith('postgresql://') && !uri.startsWith('postgres://')) {
    throw new Error('The database URI must start with postgresql:// or postgres://');
  }

  if (uri.includes('[YOUR-PASSWORD]')) {
    const password = await askHidden('Paste the Supabase database password: ');
    if (!password) throw new Error('The Supabase database password cannot be empty.');
    uri = uri.replace('[YOUR-PASSWORD]', encodeURIComponent(password));
  }

  const adminPassword = await askPassword('New admin password');
  const employeePassword = await askPassword('New listener password');
  console.log('\nChoose the payment mode:');
  console.log('1. Direct UPI app checkout now (Google Pay and other UPI apps)');
  console.log('2. Razorpay (use Test keys for testing or Live keys for real customer money)');
  const paymentChoice = await ask('Enter 1 or 2 [1]: ');
  const paymentMode = paymentChoice === '2' ? 'razorpay' : 'upi_direct';

  let upiPayeeName = '';
  let upiPaymentId = '';
  let razorpayKeyId = '';
  let razorpayKeySecret = '';
  let razorpayWebhookSecret = '';

  if (paymentMode === 'upi_direct') {
    console.log('\nUse a UPI ID that is permitted to receive these payments and is not currently limited.');
    upiPayeeName = await ask('Receiving name shown in the UPI app: ');
    if (upiPayeeName.length < 2) throw new Error('The receiving UPI name is required.');
    upiPaymentId = await ask('Receiving UPI ID: ');
    if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(upiPaymentId)) {
      throw new Error('The receiving UPI ID is invalid.');
    }
  } else {
    console.log('\nOpen Razorpay Dashboard > Account & Settings > API Keys.');
    razorpayKeyId = await ask('Paste the Razorpay Key ID: ');
    if (!/^rzp_(test|live)_/i.test(razorpayKeyId)) {
      throw new Error('The Razorpay Key ID must start with rzp_test_ or rzp_live_.');
    }
    razorpayKeySecret = await askHidden('Paste the Razorpay Key Secret: ');
    if (!razorpayKeySecret) throw new Error('The Razorpay Key Secret cannot be empty.');
    razorpayWebhookSecret = await askHidden('Paste the private Razorpay webhook secret (minimum 16 characters): ');
    if (razorpayWebhookSecret.length < 16) {
      throw new Error('The Razorpay webhook secret must contain at least 16 characters.');
    }
  }
  const vapidKeys = generateVapidKeys();

  let text = fs.readFileSync(examplePath, 'utf8');
  text = replaceLine(text, 'DATABASE_URL', uri);
  text = replaceLine(text, 'JWT_SECRET', crypto.randomBytes(64).toString('hex'));
  text = replaceLine(text, 'ADMIN_PASSWORD', adminPassword);
  text = replaceLine(text, 'DEMO_EMPLOYEE_PASSWORD', employeePassword);
  text = replaceLine(text, 'PAYMENT_GATEWAY_MODE', paymentMode);
  text = replaceLine(text, 'UPI_PAYMENT_PAYEE_NAME', upiPayeeName);
  text = replaceLine(text, 'UPI_PAYMENT_ID', upiPaymentId);
  text = replaceLine(text, 'RAZORPAY_KEY_ID', razorpayKeyId);
  text = replaceLine(text, 'RAZORPAY_KEY_SECRET', razorpayKeySecret);
  text = replaceLine(text, 'RAZORPAY_WEBHOOK_SECRET', razorpayWebhookSecret);
  text = replaceLine(text, 'VAPID_PUBLIC_KEY', vapidKeys.publicKey);
  text = replaceLine(text, 'VAPID_PRIVATE_KEY', vapidKeys.privateKey);
  text = replaceLine(text, 'RESET_SEEDED_PASSWORDS', 'true');
  fs.writeFileSync(envPath, text, 'utf8');

  console.log('\nCreated backend\\.env with new JWT and browser-notification keys plus your new account passwords.');
  console.log('The database initializer will update the seeded admin/listener accounts once.\n');
})().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => rl.close());
