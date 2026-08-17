const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (value, fallback = false) => (
  value === undefined ? fallback : String(value).toLowerCase() === 'true'
);
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'development';
const supportEmail = process.env.SUPPORT_EMAIL || 'wemetsite@gmail.com';
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const upiPaymentId = String(process.env.UPI_PAYMENT_ID || 'paytm.s3hc53w@pty').trim();
const upiPaymentPayeeName = String(process.env.UPI_PAYMENT_PAYEE_NAME || 'Paytm').trim();
const publicUrl = (
  process.env.PUBLIC_URL
  || process.env.RENDER_EXTERNAL_URL
  || 'http://localhost:3000'
).replace(/\/$/, '');

const explicitOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);

const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isRender: process.env.RENDER === 'true',
  port: number(process.env.PORT, 3000),
  appName: process.env.APP_NAME || 'We Met',
  publicUrl,
  serveFrontends: bool(process.env.SERVE_FRONTENDS, true),
  supportEmail,
  upiPayment: {
    enabled: true,
    payeeName: upiPaymentPayeeName,
    upiId: upiPaymentId,
    intentMinutes: number(process.env.UPI_PAYMENT_INTENT_MINUTES, 1440),
  },
  webPush: {
    enabled: Boolean(vapidPublicKey && vapidPrivateKey),
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
    subject: process.env.VAPID_SUBJECT || `mailto:${supportEmail}`,
  },

  jwtSecret: process.env.JWT_SECRET || '',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: bool(process.env.DATABASE_SSL, true),
  allowedOrigins: explicitOrigins.length ? explicitOrigins : [publicUrl],

  ringSeconds: number(process.env.RING_SECONDS, 30),
  minimumStartSeconds: number(process.env.MINIMUM_START_SECONDS, 120),
  lowBalanceSeconds: number(process.env.LOW_BALANCE_SECONDS, 60),
  mediaReconnectSeconds: number(process.env.MEDIA_RECONNECT_SECONDS, 45),
  listenerDisconnectGraceSeconds: number(process.env.LISTENER_DISCONNECT_GRACE_SECONDS, 45),
  maxCallSeconds: number(process.env.MAX_CALL_SECONDS, 0),

  resetSeededPasswords: bool(process.env.RESET_SEEDED_PASSWORDS, false),
  admin: {
    username: process.env.ADMIN_USERNAME || 'sabithkp',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Sabith Salah Kp',
  },
  initialListener: {
    email: process.env.INITIAL_LISTENER_EMAIL || '',
    password: process.env.INITIAL_LISTENER_PASSWORD || '',
    name: process.env.INITIAL_LISTENER_NAME || 'First Listener',
    employeeCode: process.env.INITIAL_LISTENER_CODE || 'WM-L001',
  },

  iceServers: [
    { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
    process.env.TURN_URL
      ? {
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
      }
      : null,
  ].filter(Boolean),
};

function validateConfig() {
  const problems = [];

  if (!config.databaseUrl) problems.push('DATABASE_URL is required.');
  if (!config.jwtSecret || config.jwtSecret.length < 48) {
    problems.push('JWT_SECRET must be a private random value of at least 48 characters.');
  }
  if (!config.admin.password || config.admin.password.length < 10) {
    problems.push('ADMIN_PASSWORD must contain at least 10 characters.');
  }
  if (config.initialListener.password && config.initialListener.password.length < 10) {
    problems.push('INITIAL_LISTENER_PASSWORD must contain at least 10 characters when an initial listener is configured.');
  }
  if (config.initialListener.password && !/^\S+@\S+\.\S+$/.test(config.initialListener.email)) {
    problems.push('INITIAL_LISTENER_EMAIL is required when an initial listener password is configured.');
  }
  if (config.upiPayment.payeeName.length < 2) {
    problems.push('UPI_PAYMENT_PAYEE_NAME must exactly match the receiving UPI account name.');
  }
  if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(config.upiPayment.upiId)) {
    problems.push('UPI_PAYMENT_ID must be a valid receiving UPI ID.');
  }
  if (!Number.isInteger(config.upiPayment.intentMinutes) || config.upiPayment.intentMinutes < 15 || config.upiPayment.intentMinutes > 10080) {
    problems.push('UPI_PAYMENT_INTENT_MINUTES must be between 15 and 10080.');
  }
  if (!Number.isInteger(config.listenerDisconnectGraceSeconds)
      || config.listenerDisconnectGraceSeconds < 10
      || config.listenerDisconnectGraceSeconds > 300) {
    problems.push('LISTENER_DISCONNECT_GRACE_SECONDS must be between 10 and 300.');
  }
  if (Boolean(config.webPush.publicKey) !== Boolean(config.webPush.privateKey)) {
    problems.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together.');
  }
  if (config.webPush.enabled && !/^[A-Za-z0-9_-]{80,100}$/.test(config.webPush.publicKey)) {
    problems.push('VAPID_PUBLIC_KEY is not a valid P-256 public key.');
  }
  if (config.webPush.enabled && !/^[A-Za-z0-9_-]{40,60}$/.test(config.webPush.privateKey)) {
    problems.push('VAPID_PRIVATE_KEY is not a valid P-256 private key.');
  }
  if (config.webPush.enabled && !/^(mailto:|https?:\/\/)/i.test(config.webPush.subject)) {
    problems.push('VAPID_SUBJECT must start with mailto:, http:// or https://.');
  }

  if (config.isProduction) {
    if (!config.publicUrl.startsWith('https://')) {
      problems.push('PUBLIC_URL must use HTTPS in production.');
    }
    if (config.allowedOrigins.some((origin) => !origin.startsWith('https://'))) {
      problems.push('Every ALLOWED_ORIGINS entry must use HTTPS in production.');
    }
  }

  if (problems.length) {
    throw new Error(`Configuration error:\n- ${problems.join('\n- ')}`);
  }
}

validateConfig();
module.exports = config;
