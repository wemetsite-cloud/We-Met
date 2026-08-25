# MSG91 OTP setup (v8.9.17)

This build uses the configured MSG91 OTP Widget for **new customer registration**, **new listener registration**, and **forgot-password recovery**. Returning users sign in with their password.

## Already embedded in the web clients
- Widget ID: `3668796d6a79393230383731`
- OTP Widget token name: `WEMETWEB` (the generated token value is embedded in `/shared/msg91-otp.js`)
- Web SDK mode: custom UI / exposed methods
- Official provider: `https://verify.msg91.com/otp-provider.js`
- Secondary provider fallback: `https://verify.phone91.com/otp-provider.js`

## Required Render environment variable
Add the private MSG91 account Authkey created for the server:

```text
MSG91_AUTH_KEY=<your WEMETSERVER Authkey>
```

Do **not** put the private `MSG91_AUTH_KEY` in customer or listener JavaScript. The browser receives a one-time MSG91 access token after OTP verification; the backend verifies that token with MSG91 before allowing registration or password reset.

## MSG91 dashboard checks for the web SDK
In OTP > Widgets > your widget:

1. Widget status must be **Enabled** and subscription **Active**.
2. In **Widget Settings**, keep **Mobile Integration OFF**. MSG91 states that enabling Mobile Integration makes that widget mobile-SDK-only and it will not work on the web.
3. SMS should be enabled as the primary mobile channel.
4. Channels Configuration may use MSG91 **Default Configuration** while your own DLT template is unavailable.
5. Country Wise Restriction should include every country you want to support (Allow All is valid if intended).
6. The `WEMETWEB` token must be **Enabled**.
7. For a normal website, reCAPTCHA may remain ON. If initialization still fails, temporarily turn reCAPTCHA OFF once as a diagnostic test. If that fixes it, inspect CSP/reCAPTCHA loading before turning it back on.
8. Use **Preview Demo** in MSG91. If Preview Demo itself fails, fix the widget/account configuration before changing We Met code.
9. Immediately after a failed website attempt, open OTP Widget > **Logs**. If there is no request/log at all, the provider did not reach MSG91 and the problem is client-side initialization/network/CSP. If a log exists, use its status/error to diagnose the MSG91-side rejection.

## What v8.9.17 changes
Earlier code waited for `sendOtp`, `verifyOtp`, **and `retryOtp`** before considering the SDK initialized. Some provider builds can expose resend later than the core send/verify methods, creating a false initialization timeout.

v8.9.17:
- requires only the core `sendOtp` + `verifyOtp` methods during bootstrap;
- calls `initSendOTP(configuration)` directly in the provider `load` event to mirror MSG91's documented integration;
- handles async initialization if the provider returns a Promise;
- gives `retryOtp` a short grace period and safely falls back to a fresh send when necessary;
- exposes `WMMsg91Otp.diagnostics()` in the browser console for troubleshooting.

## Login flow
- New customer/listener: phone -> MSG91 SMS OTP -> backend access-token verification -> create password/profile.
- Existing customer/listener: phone -> password. No OTP-login button.
- Forgot password: registered phone -> MSG91 SMS OTP -> backend access-token verification -> set new password.


## v8.9.17 verification correction

MSG91's `verifyAccessToken` endpoint is authoritative for successful OTP verification. Depending on Widget/API response shape, MSG91 may return the verified identifier as E.164 digits, national-number digits, or no identifier field at all. v8.9.17 therefore:

- accepts a successful server-side MSG91 verification when no identifier is exposed;
- accepts equivalent country-code vs national-number representations (minimum 8-digit suffix match); and
- still rejects the request when MSG91 explicitly exposes a different phone identifier.

This removes the false `The verified OTP does not match this mobile number` error that could appear after a correct OTP.
