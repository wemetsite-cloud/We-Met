# MSG91 OTP and Razorpay setup — We Met v8.9.18

## MSG91 OTP

The current customer and listener authentication flow uses the **MSG91 OTP Widget**, not Fast2SMS/Twilio.

Use OTP only for:

- new customer registration;
- new listener registration;
- forgot-password recovery;
- OTP-verified pre-login support.

Returning accounts use the password attached to the same verified phone number. A number that already owns an account is routed back to that account instead of creating another same-role account.

### Required Render environment

```text
MSG91_AUTH_KEY=<private WEMETSERVER Authkey>
SMS_ENABLED=false
```

The public OTP Widget configuration/token lives in `shared/msg91-otp.js`. The private MSG91 Authkey must stay on Render only.

### MSG91 dashboard

- OTP Widget subscription: Active
- Widget: Enabled
- Web SDK / Mobile Integration: Mobile Integration OFF for this web build
- SMS channel: enabled
- Template: MSG91 Default Configuration unless you intentionally move to your own DLT template
- `WEMETWEB` token: Enabled
- Country restrictions: match the countries you intend to support

Do not enable the legacy Fast2SMS/Twilio OTP variables for this build unless you intentionally restore the old server-SMS implementation.

## Razorpay wallet and membership

Keep the live Razorpay secrets in Render only:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TTIsGpwDtJmgi5`
- `RAZORPAY_SUBSCRIPTION_AMOUNT_PAISE=39900`
- `LISTENER_SUBSCRIPTION_CREDIT_PAISE=5000`

Wallet plans use Razorpay Standard Checkout directly over the wallet page. Closing checkout stays on the wallet. Talk-time is credited only after backend verification.

## Calls

Browser audio uses WebRTC + Socket.IO. The package includes multiple STUN endpoints. For production reliability across mobile carriers, CGNAT, office Wi-Fi and restrictive NAT, also configure a real TURN service in Render:

```text
TURN_URL=turn:your-turn-host:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

`TURN_URL` may contain comma-separated TURN URLs. Without TURN, some network pairs can still fail even when both users are online and microphone permission is allowed.

## Production smoke test

1. New customer → OTP → profile/password → dashboard.
2. Same customer number again → password screen, not another registration.
3. Forgot password → OTP → new password.
4. New listener → OTP → listener details → full-page voice verification.
5. Submit recording → Admin → Verifications → approve → listener workspace unlocks.
6. Listener grants microphone permission and goes Online.
7. Customer has talk-time → calls that online listener → listener receives ring → Accept → two-way audio connects → timer/billing begins only after media connects.
8. Test Reject, End, Busy/another call, Offline and Break.
9. Test customer/listener Report and Support submissions.
10. Test wallet checkout cancellation and successful top-up.
