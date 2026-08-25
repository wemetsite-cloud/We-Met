# MSG91 OTP setup for We Met v8.9.11

This build uses **password login for every existing customer/listener**. OTP is used for **new account phone verification** and **Forgot password** recovery. The existing login screen no longer offers an OTP-login bypass.

## Already configured in this ZIP

- OTP Widget ID is configured in `customer-site/config.js` and `employee-site/config.js`.
- The OTP Widget client token (`WEMETWEB`) is configured for the browser SDK.
- Both sites use MSG91 **Web SDK for custom UI**, so the existing We Met forms remain unchanged.
- `sendOtp`, `verifyOtp`, and `retryOtp` are wrapped by `/shared/msg91-otp.js`.
- The backend accepts the verified MSG91 access token and creates a short-lived one-time registration/reset token only after server-side verification.
- Legacy Fast2SMS/Twilio sending is disabled (`SMS_ENABLED=false`).

## One required Render secret

Add this environment variable to the backend service before going live:

`MSG91_AUTH_KEY=<your private MSG91 account Authkey>`

Use the **account Authkey from MSG91 Server Side Integration/Authkey**, not the `WEMETWEB` OTP Widget token. Never place `MSG91_AUTH_KEY` in frontend files.

Then redeploy the backend.

## Authentication behavior

1. User enters phone number.
2. Backend checks whether that role+phone already exists.
3. Existing account: password screen only. If forgotten, user chooses **Forgot password**, receives MSG91 OTP, verifies it, and sets a new password.
4. New account: MSG91 OTP is sent, verified, and the user then creates their profile + password.
5. Returning users continue to use the password they created.

## OTP length

The current MSG91 widget in the supplied setup is 4 digits. The forms accept 4–6 digits so the site also works if you later change the widget to 6 digits.
