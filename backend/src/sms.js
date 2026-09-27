'use strict';

const config = require('./config');
const { internationalPhone, indianMobile } = require('./phone');

async function sendTwilioOtp(phone, otp, reference) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.sms.twilioAccountSid)}/Messages.json`;
  const body = new URLSearchParams({
    To: phone,
    Body: `${config.appName} verification code: ${otp}. It expires in ${config.sms.otpExpiryMinutes} minutes. Never share this code.`,
  });
  if (config.sms.twilioMessagingServiceSid) body.set('MessagingServiceSid', config.sms.twilioMessagingServiceSid);
  else body.set('From', config.sms.twilioFromNumber);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.sms.twilioAccountSid}:${config.sms.twilioAuthToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    console.error('Twilio OTP request failed:', error?.message || error);
    throw Object.assign(new Error('The OTP could not be sent. Please try again.'), { status: 502 });
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.sid) {
    console.error('Twilio OTP rejected:', response.status, payload?.code || payload?.message || 'unknown');
    throw Object.assign(new Error(payload?.message || 'The OTP could not be sent. Check the country code and number.'), { status: 502 });
  }
  return { provider: 'twilio', requestId: payload.sid || reference || null };
}

async function sendMsg91Otp(phone, otp, reference) {
  const mobile = String(phone || '').replace(/^\+/, '');
  const endpoint = new URL('https://control.msg91.com/api/v5/otp');
  endpoint.searchParams.set('template_id', config.msg91.otpTemplateId);
  endpoint.searchParams.set('mobile', mobile);
  endpoint.searchParams.set('otp', String(otp));
  endpoint.searchParams.set('otp_expiry', String(config.sms.otpExpiryMinutes));

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', authkey: config.msg91.authKey },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    console.error('MSG91 native OTP request failed:', error?.message || error);
    throw Object.assign(new Error('The OTP could not be sent. Please try again.'), { status: 502 });
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || String(payload?.type || '').toLowerCase() === 'error') {
    console.error('MSG91 native OTP rejected:', response.status, payload?.message || 'unknown');
    throw Object.assign(new Error(payload?.message || 'The OTP could not be sent. Check the number and try again.'), { status: 502 });
  }
  return { provider: 'msg91', requestId: payload?.request_id || payload?.requestId || reference || null };
}

async function sendOtp(phone, otp, reference = '') {
  const normalized = internationalPhone(phone);
  if (!normalized) throw Object.assign(new Error('Enter a valid mobile number with country code.'), { status: 400 });

  // Native Android registration uses a server-generated challenge and sends
  // the exact code through MSG91. The private auth key never reaches the app.
  if (config.msg91.otpEnabled) return sendMsg91Otp(normalized, otp, reference);

  if (!config.sms.enabled) {
    if (config.sms.testOtp) return { provider: 'development', requestId: reference || null };
    throw Object.assign(new Error('SMS OTP is not enabled on the server yet.'), { status: 503, code: 'SMS_NOT_CONFIGURED' });
  }

  if (config.sms.provider === 'twilio') return sendTwilioOtp(normalized, otp, reference);

  const mobile = indianMobile(phone);
  if (!mobile) throw Object.assign(new Error('International OTP requires SMS_PROVIDER=twilio. Fast2SMS supports Indian mobile numbers only.'), { status: 400 });

  let response;
  try {
    response = await fetch('https://www.fast2sms.com/dev/otp/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: config.sms.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mobile,
        otp_id: config.sms.otpTemplateId,
        otp: String(otp),
        otp_length: String(otp).length,
        otp_expiry: config.sms.otpExpiryMinutes,
        udf1: String(reference || '').slice(0, 120),
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    console.error('Fast2SMS OTP request failed:', error?.message || error);
    throw Object.assign(new Error('The OTP could not be sent. Please try again.'), { status: 502 });
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || payload?.return === false || payload?.status_code >= 400) {
    console.error('Fast2SMS OTP rejected:', response.status, payload?.message || payload?.status_code || 'unknown');
    throw Object.assign(new Error(payload?.message || 'The OTP could not be sent. Please check the number and try again.'), { status: 502 });
  }

  return {
    provider: 'fast2sms',
    requestId: payload?.request_id || payload?.requestId || reference || null,
  };
}

module.exports = { sendOtp };
