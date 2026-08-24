# We Met v8.7 deployment

This package contains the customer site, listener workspace, admin operations portal, API server and PostgreSQL schema.

## Portal URLs

When `SERVE_FRONTENDS=true`, one deployment serves:

- Customer: `https://wemet.xyz/`
- Listener: `https://wemet.xyz/listener/`
- Admin: `https://wemet.xyz/admin/`
- Health check: `https://wemet.xyz/api/health`

The optional `listener.wemet.xyz` and `admin.wemet.xyz` custom domains can point to the same Render service. The server selects the correct portal from the hostname.

## Deploy on Render

1. Create or connect a PostgreSQL database.
2. Deploy the repository root using `render.yaml`.
3. Open the Render service's **Environment** page and enter every value marked `sync: false`.
4. Follow `SMS_RAZORPAY_SETUP.md` for SMS OTP, recurring memberships and the Razorpay webhook.
5. Deploy again after saving the environment variables.
6. Confirm `/api/health` returns `{"ok":true}` and test all three portal URLs.

The start command runs the idempotent database schema before the server starts. Keep database backups enabled before every production release.

## Required production secrets

Never add these values to frontend files or commit them to source control:

- `DATABASE_URL`
- `JWT_SECRET` — random, private and at least 48 characters
- `ADMIN_PASSWORD` — at least 10 characters
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- Fast2SMS: `FAST2SMS_API_KEY` and `FAST2SMS_OTP_TEMPLATE_ID`
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus a sender number or Messaging Service SID

Use matching Razorpay test credentials while testing and matching live credentials only after the account is approved for production. HTTPS is required in production.

## Local start

1. Copy `.env.example` to `.env` and fill in the local values.
2. Run `npm run install:backend`.
3. Run `npm run db:init`.
4. Run `npm start`.

The default local customer URL is `http://localhost:3000/`; listener and admin are under `/listener/` and `/admin/`.

## Release checks

1. Register a new customer by OTP; then test both password login and the optional **Sign in with SMS OTP** action.
2. Register a listener, record the Malayalam line and approve the submission from Admin → Verifications.
3. Confirm the customer can follow and make a wallet-funded random/direct call without membership, but cannot view exclusive posts or message before membership.
4. Buy the listener's ₹399 membership and confirm posts and messages unlock.
5. Confirm any customer with an empty talk-time wallet is sent to Wallet, including an active member; membership never provides a free call.
6. Buy talk-time from Wallet and confirm Standard Checkout opens over the same page, cancellation stays on Wallet, and successful backend verification credits the exact minutes.
7. Confirm Admin → Payments records the top-up, subscription payment and ₹50 listener credit exactly once.
8. Save a listener UPI ID, request a withdrawal, and use Admin → Withdrawals to mark it paid with the real UTR.
9. Reset one customer and one listener password by SMS OTP and confirm there is no admin approval queue.
10. Open a subscribed listener's post and scroll the full-screen customer feed; then verify the listener feed's liker list and edit/delete menu.
11. Refresh each portal once so the v8.7 service worker replaces the old cache.

## Render duplicate-phone migration

The included migration repairs the legacy `uq_users_role_phone` startup failure before creating the unique index. If an older database contains more than one account with the same role and phone, it keeps the active account with the strongest wallet/activity record and clears the phone only from older duplicate rows. It does not delete an account, call, wallet entry, payment, post or message.

After uploading v8.7, use **Manual Deploy → Deploy latest commit** in Render. A successful log contains `We Met database initialized successfully`, followed by the server startup line. Then open `/api/health` before testing `/admin/`.

Listener payouts remain administrator-managed: the listener saves a UPI ID and requests a withdrawal, the admin pays it externally, then uses **Admin → Withdrawals → Mark paid** and enters the real UTR. The request, UTR and ledger entry remain auditable.
