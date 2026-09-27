const crypto = require('crypto');
const config = require('./config');

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

function serviceAccount() {
  if (!config.googlePlay.enabled) {
    throw Object.assign(new Error('Google Play purchases are not enabled yet.'), { status: 503 });
  }

  try {
    const decoded = Buffer.from(config.googlePlay.serviceAccountJsonBase64, 'base64').toString('utf8');
    const account = JSON.parse(decoded);
    if (!account.client_email || !account.private_key) throw new Error('Missing service account fields');
    return account;
  } catch (_error) {
    throw Object.assign(new Error('Google Play purchase verification is not configured correctly.'), { status: 503 });
  }
}

function signedAssertion(account) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({
    iss: account.client_email,
    scope: ANDROID_PUBLISHER_SCOPE,
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function accessToken() {
  if (cachedAccessToken && cachedAccessTokenExpiry > Date.now() + 60_000) return cachedAccessToken;

  const account = serviceAccount();
  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(account),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw Object.assign(new Error('Google Play purchase verification is temporarily unavailable.'), { status: 502 });
  }

  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(body.expires_in || 3600)) * 1000;
  return cachedAccessToken;
}

async function verifyProductPurchase(purchaseToken) {
  const token = await accessToken();
  const packageName = encodeURIComponent(config.googlePlay.packageName);
  const purchase = encodeURIComponent(purchaseToken);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/productsv2/tokens/${purchase}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) {
      throw Object.assign(new Error('Google Play could not verify this purchase.'), { status: 400 });
    }
    throw Object.assign(new Error('Google Play purchase verification is temporarily unavailable.'), { status: 502 });
  }
  return body;
}

module.exports = { verifyProductPurchase };
