(() => {
  'use strict';

  const WIDGET_ID = '3668796d6a79393230383731';
  const TOKEN_AUTH = '564321Tz6E6W8wB986a8d9732P1';
  const PROVIDERS = [
    'https://verify.msg91.com/otp-provider.js',
    'https://verify.phone91.com/otp-provider.js',
  ];
  const CAPTCHA_ID = 'wmMsg91Captcha';
  let readyPromise = null;
  let requestId = '';
  let providerIndex = 0;

  function ensureCaptchaHost() {
    let host = document.getElementById(CAPTCHA_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = CAPTCHA_ID;
      host.className = 'wm-msg91-captcha';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function errorMessage(error, fallback = 'OTP service is temporarily unavailable. Please try again.') {
    if (!error) return fallback;
    if (typeof error === 'string') return error;
    const candidates = [
      error.message,
      error.error,
      error.description,
      error.msg,
      error.data?.message,
      error.data?.error,
      error.response?.message,
      error.response?.error,
    ];
    const found = candidates.find((value) => typeof value === 'string' && value.trim());
    return found ? found.trim() : fallback;
  }

  function normalizeIdentifier(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) throw new Error('Enter a valid mobile number with country code.');
    return digits;
  }

  function findRequestId(data) {
    if (!data || typeof data !== 'object') return '';
    return String(data.reqId || data.req_id || data.requestId || data.request_id || data.data?.reqId || data.data?.requestId || '').trim();
  }

  function looksLikeJwt(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
  }

  function findAccessToken(data) {
    if (looksLikeJwt(data)) return data.trim();
    if (!data || typeof data !== 'object') return '';
    const direct = [
      data.accessToken,
      data['access-token'],
      data.access_token,
      data.token,
      data.jwt,
      data.message,
      data.data?.accessToken,
      data.data?.['access-token'],
      data.data?.access_token,
      data.data?.token,
      data.data?.jwt,
      data.data?.message,
    ];
    const token = direct.find(looksLikeJwt);
    return token ? token.trim() : '';
  }

  function waitForMethods(timeoutMs = 22000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function' && typeof window.retryOtp === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error('MSG91 OTP could not initialize. Refresh once and try again.'));
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((item) => item.src === src);
      if (existing && typeof window.initSendOTP === 'function') return resolve();
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('MSG91 provider failed to load.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('MSG91 provider failed to load.')), { once: true });
      document.head.appendChild(script);
    });
  }

  async function initializeWith(src) {
    ensureCaptchaHost();
    await loadScript(src);
    if (typeof window.initSendOTP !== 'function') throw new Error('MSG91 initializer was not found.');
    const configuration = {
      widgetId: WIDGET_ID,
      tokenAuth: TOKEN_AUTH,
      identifier: '',
      exposeMethods: true,
      captchaRenderId: CAPTCHA_ID,
    };
    window.initSendOTP(configuration);
    await waitForMethods();
    return true;
  }

  async function ready() {
    if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function') return true;
    if (!readyPromise) {
      readyPromise = (async () => {
        let lastError;
        for (; providerIndex < PROVIDERS.length; providerIndex += 1) {
          try {
            return await initializeWith(PROVIDERS[providerIndex]);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('MSG91 OTP could not be loaded.');
      })().catch((error) => {
        readyPromise = null;
        providerIndex = 0;
        throw error;
      });
    }
    return readyPromise;
  }

  async function send(phone) {
    document.body.classList.add('wm-msg91-active');
    await ready();
    const identifier = normalizeIdentifier(phone);
    requestId = '';
    return new Promise((resolve, reject) => {
      window.sendOtp(
        identifier,
        (data) => {
          requestId = findRequestId(data) || requestId;
          document.body.classList.remove('wm-msg91-active');
          resolve({ data, reqId: requestId });
        },
        (error) => reject(new Error(errorMessage(error, 'Could not send OTP. Please try again.'))),
      );
    });
  }

  async function retry() {
    document.body.classList.add('wm-msg91-active');
    await ready();
    return new Promise((resolve, reject) => {
      window.retryOtp(
        null,
        (data) => {
          requestId = findRequestId(data) || requestId;
          document.body.classList.remove('wm-msg91-active');
          resolve({ data, reqId: requestId });
        },
        (error) => reject(new Error(errorMessage(error, 'Could not resend OTP. Please wait and try again.'))),
        requestId || undefined,
      );
    });
  }

  async function verify(otp) {
    await ready();
    const code = String(otp || '').replace(/\D/g, '');
    if (code.length < 4 || code.length > 10) throw new Error('Enter the complete OTP.');
    return new Promise((resolve, reject) => {
      window.verifyOtp(
        code,
        (data) => {
          const accessToken = findAccessToken(data);
          if (!accessToken) {
            reject(new Error('MSG91 verified the code but did not return an access token. Please request a new OTP.'));
            return;
          }
          document.body.classList.remove('wm-msg91-active');
          resolve({ data, accessToken, reqId: requestId });
        },
        (error) => reject(new Error(errorMessage(error, 'The OTP is incorrect or expired.'))),
        requestId || undefined,
      );
    });
  }

  function reset() {
    requestId = '';
    document.body.classList.remove('wm-msg91-active');
  }

  window.WMMsg91Otp = Object.freeze({ ready, send, retry, verify, reset, widgetId: WIDGET_ID });
})();
