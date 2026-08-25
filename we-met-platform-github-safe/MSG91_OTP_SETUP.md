# MSG91 OTP setup (v8.9.13)

This build uses the configured MSG91 OTP Widget for **new customer registration**, **new listener registration**, and **forgot-password recovery**. Returning users sign in with their password.

## Already embedded in the web clients
- Widget ID: `3668796d6a79393230383731`
- OTP Widget token name: `WEMETWEB` (the generated token value is embedded in `/shared/msg91-otp.js`)
- Web SDK mode: custom UI / exposed methods

## Required Render environment variable
Add the private MSG91 account Authkey created for the server:

```text
MSG91_AUTH_KEY=<your WEMETSERVER Authkey>
```

Do **not** put the private `MSG91_AUTH_KEY` in customer or listener JavaScript. The browser receives a one-time MSG91 access token after OTP verification; the backend verifies that token with MSG91 and checks that the verified phone matches the requested account phone before allowing registration or password reset.

## Flow
- New customer/listener: phone -> MSG91 SMS OTP -> backend access-token verification -> create password/profile.
- Existing customer/listener: phone -> password. No OTP-login button.
- Forgot password: registered phone -> MSG91 SMS OTP -> backend access-token verification -> set new password.

The old Fast2SMS/Twilio OTP code remains only for the separate pre-login support verification path; it is not used for registration or forgot-password in this build.
