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
  supportEmail: process.env.SUPPORT_EMAIL || 'wemetsite@gmail.com',
  paymentUpiId: process.env.PAYMENT_UPI_ID || 'salahkpsite@slc',
  paymentPayeeName: process.env.PAYMENT_PAYEE_NAME || 'We Met',

  jwtSecret: process.env.JWT_SECRET || '',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: bool(process.env.DATABASE_SSL, true),
  allowedOrigins: explicitOrigins.length ? explicitOrigins : [publicUrl],

  ringSeconds: number(process.env.RING_SECONDS, 30),
  minimumStartSeconds: number(process.env.MINIMUM_START_SECONDS, 120),
  lowBalanceSeconds: number(process.env.LOW_BALANCE_SECONDS, 60),
  mediaReconnectSeconds: number(process.env.MEDIA_RECONNECT_SECONDS, 45),
  maxCallSeconds: number(process.env.MAX_CALL_SECONDS, 0),

  resetSeededPasswords: bool(process.env.RESET_SEEDED_PASSWORDS, false),
  admin: {
    username: process.env.ADMIN_USERNAME || 'sabithkp',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Sabith Salah Kp',
  },
  demoEmployee: {
    email: process.env.DEMO_EMPLOYEE_EMAIL || 'gentle8x@gmail.com',
    password: process.env.DEMO_EMPLOYEE_PASSWORD || '',
    name: process.env.DEMO_EMPLOYEE_NAME || 'Salah',
    employeeCode: process.env.DEMO_EMPLOYEE_CODE || 'WM-L001',
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
  if (!config.demoEmployee.password || config.demoEmployee.password.length < 10) {
    problems.push('DEMO_EMPLOYEE_PASSWORD must contain at least 10 characters.');
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
