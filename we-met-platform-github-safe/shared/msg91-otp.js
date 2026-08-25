(() => {
  'use strict';

  const config = window.PORTAL_CONFIG || {};
  const widgetId = String(config.MSG91_WIDGET_ID || '').trim();
  const tokenAuth = String(config.MSG91_WIDGET_TOKEN || '').trim();
  let readyPromise = null;
  let currentReqId = '';

  function normalizeIdentifier(value) {
    const raw = String(value || '').trim();
    if (raw.includes('@')) return raw.toLowerCase();
    return raw.replace(/\D/g, '');
  }

  function findValue(input, acceptedKeys) {
    const seen = new Set();
    function walk(value, depth = 0) {
      if (depth > 6 || value == null) return '';
      if (typeof value === 'string') {
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && acceptedKeys.has('jwt')) return value;
        return '';
      }
      if (typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      for (const [key, nested] of Object.entries(value)) {
        const normalizedKey = String(key).toLowerCase().replace(/[_-]/g, '');
        if (acceptedKeys.has(normalizedKey) && typeof nested === 'string' && nested.trim()) return nested.trim();
      }
      for (const nested of Object.values(value)) {
        const found = walk(nested, depth + 1);
        if (found) return found;
      }
      return '';
    }
    return walk(input);
  }

  function extractReqId(data) {
    return findValue(data, new Set(['reqid', 'requestid']));
  }

  function extractAccessToken(data) {
    return findValue(data, new Set(['accesstoken', 'jwt', 'token']));
  }

  function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      if (!widgetId || !tokenAuth) {
        reject(new Error('MSG91 OTP widget is not configured.'));
        return;
      }

      const waitForMethods = (startedAt = Date.now()) => {
        if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function' && typeof window.retryOtp === 'function') {
          resolve();
          return;
        }
        if (Date.now() - startedAt > 8000) {
          reject(new Error('MSG91 OTP is taking too long to initialize. Please refresh and try again.'));
          return;
        }
        setTimeout(() => waitForMethods(startedAt), 80);
      };

      const initialize = () => {
        if (typeof window.initSendOTP !== 'function') {
          reject(new Error('MSG91 OTP could not be loaded. Please refresh and try again.'));
          return;
        }
        try {
          const initResult = window.initSendOTP({
            widgetId,
            tokenAuth,
            identifier: '',
            exposeMethods: true,
            captchaRenderId: 'msg91Captcha',
          });
          if (initResult && typeof initResult.then === 'function') {
            initResult.then(() => waitForMethods()).catch(reject);
          } else {
            waitForMethods();
          }
        } catch (error) {
          reject(error);
        }
      };

      if (typeof window.initSendOTP === 'function') {
        initialize();
        return;
      }

      const existing = document.querySelector('script[data-msg91-otp-provider]');
      if (existing) {
        existing.addEventListener('load', initialize, { once: true });
        existing.addEventListener('error', () => reject(new Error('MSG91 OTP could not be loaded.')), { once: true });
        return;
      }

      const providerUrls = [
        'https://verify.msg91.com/otp-provider.js',
        'https://verify.phone91.com/otp-provider.js',
      ];
      let providerIndex = 0;

      const loadProvider = () => {
        const script = document.createElement('script');
        script.src = providerUrls[providerIndex];
        script.async = true;
        script.dataset.msg91OtpProvider = 'true';
        script.onload = initialize;
        script.onerror = () => {
          script.remove();
          providerIndex += 1;
          if (providerIndex < providerUrls.length) {
            loadProvider();
            return;
          }
          reject(new Error('MSG91 OTP provider could not be loaded. Please refresh and try again.'));
        };
        document.head.appendChild(script);
      };

      loadProvider();
    });
    return readyPromise;
  }

  function providerCall(method, args = []) {
    return ensureReady().then(() => new Promise((resolve, reject) => {
      const fn = window[method];
      if (typeof fn !== 'function') {
        reject(new Error('MSG91 OTP is still loading. Please try again in a moment.'));
        return;
      }
      fn(...args, (data) => resolve(data), (error) => {
        const message = error?.message || error?.error || error?.data?.message || 'OTP request failed. Please try again.';
        reject(Object.assign(new Error(String(message)), { details: error }));
      });
    }));
  }

  async function send(identifier) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) throw new Error('Enter a valid mobile number.');
    const data = await providerCall('sendOtp', [normalized]);
    currentReqId = extractReqId(data) || currentReqId;
    return data;
  }

  async function verify(otp) {
    const code = String(otp || '').replace(/\D/g, '');
    if (!/^\d{4,10}$/.test(code)) throw new Error('Enter the complete OTP.');
    const data = await ensureReady().then(() => new Promise((resolve, reject) => {
      if (typeof window.verifyOtp !== 'function') return reject(new Error('MSG91 OTP is still loading. Please try again.'));
      window.verifyOtp(
        code,
        (result) => resolve(result),
        (error) => reject(Object.assign(new Error(error?.message || error?.error || 'The OTP is incorrect or expired.'), { details: error })),
        currentReqId || undefined,
      );
    }));
    const accessToken = extractAccessToken(data);
    if (!accessToken) throw new Error('OTP was verified but MSG91 did not return an access token. Please request a new OTP.');
    return { data, accessToken };
  }

  async function retry() {
    const data = await ensureReady().then(() => new Promise((resolve, reject) => {
      if (typeof window.retryOtp !== 'function') return reject(new Error('MSG91 OTP is still loading. Please try again.'));
      window.retryOtp(
        null,
        (result) => resolve(result),
        (error) => reject(Object.assign(new Error(error?.message || error?.error || 'OTP could not be resent.'), { details: error })),
        currentReqId || undefined,
      );
    }));
    currentReqId = extractReqId(data) || currentReqId;
    return data;
  }

  function reset() {
    currentReqId = '';
  }


  document.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-msg91-resend]');
    if (!button) return;
    event.preventDefault();
    button.disabled = true;
    try {
      await retry();
      window.Portal?.toast?.('OTP resent.', 'success');
    } catch (error) {
      window.Portal?.toast?.(error.message || 'OTP could not be resent.', 'error');
    } finally {
      setTimeout(() => { button.disabled = false; }, 1000);
    }
  });

  window.WeMetOtp = Object.freeze({ ensureReady, send, verify, retry, reset, normalizeIdentifier });
})();
