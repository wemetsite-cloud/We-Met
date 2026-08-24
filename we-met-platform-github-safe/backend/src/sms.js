'use strict';

const config = require('./config');
const { indianMobile } = require('./phone');

async function sendOtp(phone, otp, reference = '') {
  const mobile = indianMobile(phone);
  if (!mobile) throw Object.assign(new Error('OTP SMS is currently available only for Indian mobile numbers.'), { status: 400 });

  if (!config.sms.enabled) {
    if (config.sms.testOtp) {
      return { provider: 'development', requestId: reference || null };
    }
    throw Object.assign(new Error('SMS OTP is not enabled on the server yet.'), { status: 503, code: 'SMS_NOT_CONFIGURED' });
  }

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
