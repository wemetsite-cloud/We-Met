# SMS OTP setup — MSG91 OTP Widget

We Met v8.9.12 uses the MSG91 OTP Widget for SMS verification. Returning users **do not have OTP login**: they sign in with their password. OTP is used for new-account phone verification and Forgot password recovery.

## Required deployment secret

In **Render Dashboard → we-met-platform → Environment**, set:

- `MSG91_AUTH_KEY=YOUR_PRIVATE_MSG91_ACCOUNT_AUTHKEY`
- keep `SMS_ENABLED=false`

The browser Widget ID and `WEMETWEB` OTP Widget token are already configured in the customer/listener site config. The private account Authkey is different from the Widget token and must remain backend-only.

## Flow

- New customer/listener → MSG91 sends OTP → browser verifies OTP → backend verifies the returned MSG91 access token → account creation is unlocked.
- Existing customer/listener → password only.
- Forgot password → MSG91 sends OTP → backend verifies the returned access token → one-time password reset is unlocked.

The old Fast2SMS/Twilio sender code remains only as inactive legacy code; the Render blueprint disables it.
