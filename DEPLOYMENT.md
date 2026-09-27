# We Met v8.9.18 deployment

This package contains the customer site, listener workspace, admin portal, Node.js API/Socket.IO server and PostgreSQL schema.

## Portal URLs

When `SERVE_FRONTENDS=true`, one deployment serves:

- Customer: `https://wemet.xyz/`
- Listener: `https://wemet.xyz/employee/` (alias: `/listener/`)
- Admin: `https://wemet.xyz/admin/`
- Health: `https://wemet.xyz/api/health`

## Render

1. Connect the repository root to Render and a PostgreSQL database.
2. Deploy with `render.yaml` or keep the equivalent existing Web Service settings.
3. In **Environment**, keep all private values out of GitHub/frontend files.
4. Required authentication secret: `MSG91_AUTH_KEY=<WEMETSERVER Authkey>`.
5. Keep `SMS_ENABLED=false` for this MSG91 Widget build.
6. Keep the existing Razorpay and database/JWT/admin secrets.
7. For reliable WebRTC on restrictive networks, configure `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
8. Redeploy and wait for **Live**.
9. Confirm `/api/health` before testing the portals.

The start command runs the idempotent database initialization before the server starts.

## Listener verification

A new listener cannot use the workspace until voice approval:

`OTP registration → Open Listener App → full-page voice recording → Send for verification → pending review → Admin approval → workspace`

Admin can edit the Malayalam reading sentence under the verification section. The listener page fetches and displays that saved sentence. While verification is not approved, normal listener workspace API routes remain blocked, while the verification GET/audio-upload routes remain available.

## Authentication

- New customer/listener: MSG91 OTP once, then create password.
- Returning customer/listener with the same role + phone: password login.
- Forgot password: MSG91 OTP, then set a new password.
- Pre-login support: MSG91 verification before submitting the issue.

## Release checks

Test on phone, tablet and desktop after every production deployment. Use an Incognito window once after a cache-version change.

- fixed customer bottom navigation;
- listener discovery/profile pages;
- 6-column desktop wallet packs and responsive tablet/mobile grids;
- customer account/security actions;
- listener login, voice verification, pending/approved states;
- listener desktop tabs, online/offline/break;
- calls, WebRTC audio, ring/accept/reject/end/busy;
- reports/support;
- Razorpay wallet top-up and exclusive membership;
- listener posts/messages/earnings/profile;
- admin verification approval and operational pages.

## MSG91 OTP configuration

This build uses the MSG91 OTP Widget for new customer/listener registration,
forgot-password recovery and verified pre-login support. Returning accounts use
their password.

Required private Render configuration:

```text
MSG91_AUTH_KEY=<your WEMETSERVER Authkey>
SMS_ENABLED=false
```

The public widget configuration lives in `shared/msg91-otp.js`; never place the
private Authkey in frontend JavaScript. In the MSG91 dashboard, keep the widget
and `WEMETWEB` token enabled, SMS enabled, and Mobile Integration OFF for this
web build. The widget's Preview Demo and Logs are the fastest way to separate
provider/account errors from browser initialization errors.

The server accepts equivalent verified phone representations with or without a
country-code prefix while still rejecting an explicitly different number.

## Razorpay membership configuration

Keep these live values in Render only:

```text
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TTIsGpwDtJmgi5
RAZORPAY_SUBSCRIPTION_AMOUNT_PAISE=39900
LISTENER_SUBSCRIPTION_CREDIT_PAISE=5000
```

Configure the Razorpay webhook at `/api/subscriptions/webhook`. Wallet top-ups
and ₹399 listener memberships unlock only after backend verification. A
cancelled renewal keeps Exclusive access until the current paid period ends.

## Production smoke test

1. Register a new customer by OTP, then sign in again by password.
2. Complete forgot-password recovery by OTP.
3. Register and approve a listener, then set the listener Online.
4. Place, accept and end a two-way audio call; confirm billing starts only after connection.
5. Test Reject, Busy, Offline and Break states.
6. Test wallet checkout cancellation and a successful verified top-up.
7. Start a ₹399 listener autopay and confirm that listener's Exclusive posts/messages unlock.
8. Turn off renewal and confirm access remains only through the paid period.
9. In the admin customer profile, verify autopay history, direct access grant/revoke and password reset.
