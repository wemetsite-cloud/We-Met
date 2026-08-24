const fs = require('fs');
const path = require('path');

const envPaths = [
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
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
const smsEnabled = bool(process.env.SMS_ENABLED, false);
const smsProvider = String(process.env.SMS_PROVIDER || 'fast2sms').trim().toLowerCase();
const fast2smsApiKey = String(process.env.FAST2SMS_API_KEY || '').trim();
const fast2smsOtpTemplateId = String(process.env.FAST2SMS_OTP_TEMPLATE_ID || '').trim();
const twilioAccountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const twilioAuthToken = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const twilioFromNumber = String(process.env.TWILIO_FROM_NUMBER || '').trim();
const twilioMessagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
const publicUrl = (
  process.env.PUBLIC_URL
  || process.env.RENDER_EXTERNAL_URL
  || 'http://localhost:3000'
).replace(/\/$/, '');

const explicitOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const platformOrigins = [publicUrl, process.env.RENDER_EXTERNAL_URL]
  .map((value) => String(value || '').trim().replace(/\/$/, ''))
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
  sms: {
    provider: smsProvider,
    enabled: smsEnabled,
    apiKey: fast2smsApiKey,
    otpTemplateId: fast2smsOtpTemplateId,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    twilioMessagingServiceSid,
    otpExpiryMinutes: number(process.env.SMS_OTP_EXPIRY_MINUTES, 10),
    testOtp: nodeEnv === 'production' ? '' : String(process.env.SMS_TEST_OTP || '123456').trim(),
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
  allowedOrigins: [...new Set(explicitOrigins.length ? [...explicitOrigins, ...platformOrigins] : platformOrigins)],

  ringSeconds: number(process.env.RING_SECONDS, 30),
  minimumStartSeconds: number(process.env.MINIMUM_START_SECONDS, 1),
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
    phone: process.env.INITIAL_LISTENER_PHONE || '',
    password: process.env.INITIAL_LISTENER_PASSWORD || '',
    name: process.env.INITIAL_LISTENER_NAME || 'First Listener',
    username: process.env.INITIAL_LISTENER_USERNAME || 'first.listener',
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
  if (config.initialListener.password && !/^\+[1-9]\d{7,14}$/.test(String(config.initialListener.phone).replace(/[\s()-]/g, ''))) {
    problems.push('INITIAL_LISTENER_PHONE must be a valid E.164 number, including country code, when an initial listener password is configured.');
  }
  if (config.initialListener.password && !/^[a-z0-9._-]{3,50}$/i.test(config.initialListener.username)) {
    problems.push('INITIAL_LISTENER_USERNAME must contain 3–50 letters, numbers, dots, underscores or hyphens.');
  }
  if (!Number.isInteger(config.listenerDisconnectGraceSeconds)
      || config.listenerDisconnectGraceSeconds < 10
      || config.listenerDisconnectGraceSeconds > 300) {
    problems.push('LISTENER_DISCONNECT_GRACE_SECONDS must be between 10 and 300.');
  }
  if (Boolean(config.webPush.publicKey) !== Boolean(config.webPush.privateKey)) {
    problems.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together.');
  }
  if (!['fast2sms', 'twilio'].includes(config.sms.provider)) {
    problems.push('SMS_PROVIDER must be fast2sms or twilio.');
  }
  if (config.sms.enabled && config.sms.provider === 'fast2sms' && (!config.sms.apiKey || !config.sms.otpTemplateId)) {
    problems.push('FAST2SMS_API_KEY and FAST2SMS_OTP_TEMPLATE_ID are required when SMS_PROVIDER=fast2sms and SMS_ENABLED=true.');
  }
  if (config.sms.enabled && config.sms.provider === 'twilio'
      && (!config.sms.twilioAccountSid || !config.sms.twilioAuthToken
        || (!config.sms.twilioFromNumber && !config.sms.twilioMessagingServiceSid))) {
    problems.push('Twilio account credentials and either TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID are required when SMS_PROVIDER=twilio.');
  }
  if (!Number.isInteger(config.sms.otpExpiryMinutes) || config.sms.otpExpiryMinutes < 1 || config.sms.otpExpiryMinutes > 30) {
    problems.push('SMS_OTP_EXPIRY_MINUTES must be between 1 and 30.');
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
