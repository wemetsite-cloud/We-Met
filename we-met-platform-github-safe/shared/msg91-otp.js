(() => {
  'use strict';

  const WIDGET_ID = '3668796d6a79393230383731';
  const TOKEN_AUTH = '564321Tz6E6W8wB986a8d9732P1';
  const PROVIDERS = [
    'https://verify.msg91.com/otp-provider.js',
    'https://verify.phone91.com/otp-provider.js',
  ];
  const CAPTCHA_ID = 'wmMsg91Captcha';
  const PROVIDER_TIMEOUT_MS = 15000;
  const METHOD_TIMEOUT_MS = 15000;

  let readyPromise = null;
  let requestId = '';
  let lastIdentifier = '';
  let providerIndex = 0;
  let lastInitError = '';

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

  function coreMethodsReady() {
    // retryOtp is intentionally NOT required here. Some SDK builds expose it only
    // after the first OTP request. Requiring it during bootstrap can cause a false
    // "could not initialize" error even when sendOtp/verifyOtp are already ready.
    return typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function';
  }

  function waitForCoreMethods(timeoutMs = METHOD_TIMEOUT_MS) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (coreMethodsReady()) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          const detail = lastInitError ? ` (${lastInitError})` : '';
          reject(new Error(`MSG91 OTP could not initialize${detail}. Check MSG91 Widget Settings and refresh once.`));
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  function waitForRetryMethod(timeoutMs = 2500) {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (typeof window.retryOtp === 'function') return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    });
  }

  function providerScript(src) {
    return [...document.scripts].find((item) => item.src === src);
  }

  function removeProviderScript(src) {
    const existing = providerScript(src);
    if (existing?.dataset?.wmMsg91Dynamic === '1') existing.remove();
  }

  function makeConfiguration() {
    return {
      widgetId: WIDGET_ID,
      tokenAuth: TOKEN_AUTH,
      identifier: '',
      exposeMethods: true,
      captchaRenderId: CAPTCHA_ID,
      // Keep callbacks because the official MSG91 example includes them. We use
      // method-level callbacks for the actual OTP flow, so these are diagnostics.
      success: () => {},
      failure: (error) => {
        lastInitError = errorMessage(error, 'MSG91 widget rejected the request');
        console.warn('MSG91 widget failure:', error);
      },
    };
  }

  function initializeExistingProvider() {
    if (typeof window.initSendOTP !== 'function') return Promise.reject(new Error('MSG91 initializer was not found.'));
    ensureCaptchaHost();
    const configuration = makeConfiguration();
    try {
      const result = window.initSendOTP(configuration);
      if (result && typeof result.then === 'function') {
        return result.then(() => waitForCoreMethods());
      }
      return waitForCoreMethods();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function initializeWith(src) {
    ensureCaptchaHost();

    // If the provider is already loaded, initialize immediately.
    if (providerScript(src) && typeof window.initSendOTP === 'function') {
      return initializeExistingProvider();
    }

    return new Promise((resolve, reject) => {
      const existing = providerScript(src);
      const script = existing || document.createElement('script');
      let settled = false;

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error || 'MSG91 provider failed to load.')));
      };

      const timer = setTimeout(() => {
        finishReject(new Error('MSG91 provider script timed out while loading.'));
      }, PROVIDER_TIMEOUT_MS);

      const onLoad = () => {
        // Call initSendOTP directly inside the provider's load event. This mirrors
        // MSG91's documented: onload="initSendOTP(configuration)" integration and
        // avoids a timing/currentScript race seen with deferred initialization.
        try {
          if (typeof window.initSendOTP !== 'function') throw new Error('MSG91 initializer was not found after the provider loaded.');
          const configuration = makeConfiguration();
          const result = window.initSendOTP(configuration);
          Promise.resolve(result)
            .then(() => waitForCoreMethods())
            .then(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(true);
            })
            .catch((error) => {
              clearTimeout(timer);
              finishReject(error);
            });
        } catch (error) {
          clearTimeout(timer);
          finishReject(error);
        }
      };

      const onError = () => {
        clearTimeout(timer);
        finishReject(new Error('MSG91 provider failed to load.'));
      };

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });

      if (!existing) {
        script.src = src;
        script.async = true;
        script.dataset.wmMsg91Dynamic = '1';
        document.head.appendChild(script);
      }
    });
  }

  async function ready() {
    if (coreMethodsReady()) return true;
    if (!readyPromise) {
      readyPromise = (async () => {
        let lastError;
        for (; providerIndex < PROVIDERS.length; providerIndex += 1) {
          const src = PROVIDERS[providerIndex];
          try {
            return await initializeWith(src);
          } catch (error) {
            lastError = error;
            console.warn(`MSG91 provider initialization failed for ${src}:`, error);
            removeProviderScript(src);
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
    try {
      await ready();
      const identifier = normalizeIdentifier(phone);
      lastIdentifier = identifier;
      requestId = '';
      return await new Promise((resolve, reject) => {
        window.sendOtp(
          identifier,
          (data) => {
            requestId = findRequestId(data) || requestId;
            resolve({ data, reqId: requestId });
          },
          (error) => reject(new Error(errorMessage(error, 'Could not send OTP. Please try again.'))),
        );
      });
    } finally {
      document.body.classList.remove('wm-msg91-active');
    }
  }

  async function retry() {
    document.body.classList.add('wm-msg91-active');
    try {
      await ready();
      const hasRetry = await waitForRetryMethod();
      if (!hasRetry) {
        // Safe compatibility fallback: if this MSG91 SDK version does not expose
        // retryOtp until later, request a fresh OTP using the same identifier.
        if (!lastIdentifier) throw new Error('Request an OTP first.');
        return await new Promise((resolve, reject) => {
          window.sendOtp(
            lastIdentifier,
            (data) => {
              requestId = findRequestId(data) || requestId;
              resolve({ data, reqId: requestId });
            },
            (error) => reject(new Error(errorMessage(error, 'Could not resend OTP. Please wait and try again.'))),
          );
        });
      }
      return await new Promise((resolve, reject) => {
        window.retryOtp(
          null,
          (data) => {
            requestId = findRequestId(data) || requestId;
            resolve({ data, reqId: requestId });
          },
          (error) => reject(new Error(errorMessage(error, 'Could not resend OTP. Please wait and try again.'))),
          requestId || undefined,
        );
      });
    } finally {
      document.body.classList.remove('wm-msg91-active');
    }
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
          resolve({ data, accessToken, reqId: requestId });
        },
        (error) => reject(new Error(errorMessage(error, 'The OTP is incorrect or expired.'))),
        requestId || undefined,
      );
    });
  }

  function reset() {
    requestId = '';
    lastIdentifier = '';
    document.body.classList.remove('wm-msg91-active');
  }

  function diagnostics() {
    return {
      widgetId: WIDGET_ID,
      providerIndex,
      initSendOTP: typeof window.initSendOTP,
      sendOtp: typeof window.sendOtp,
      verifyOtp: typeof window.verifyOtp,
      retryOtp: typeof window.retryOtp,
      getWidgetData: typeof window.getWidgetData,
      isCaptchaVerified: typeof window.isCaptchaVerified,
      lastInitError,
    };
  }

  window.WMMsg91Otp = Object.freeze({ ready, send, retry, verify, reset, diagnostics, widgetId: WIDGET_ID });
})();
