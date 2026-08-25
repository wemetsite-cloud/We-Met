# SMS OTP and Razorpay setup

## 1. MSG91 OTP authentication

This build uses the MSG91 OTP Widget. Returning customer/listener accounts sign in with **password only**. OTP is used for **new registration** and **Forgot password** recovery.

In **Render Dashboard → we-met-platform → Environment**, set the private server credential:

- `MSG91_AUTH_KEY=YOUR_PRIVATE_MSG91_ACCOUNT_AUTHKEY`
- keep `SMS_ENABLED=false`

Do not put the account Authkey in HTML, `config.js`, or GitHub. The browser-side Widget ID and `WEMETWEB` token are already configured, and the server verifies each successful MSG91 access token before creating a registration/reset token.

### Authentication flows included

- New customer/listener: SMS OTP verification, then create profile + password.
- Existing customer/listener: password sign-in only; no OTP-login bypass.
- Forgot password: SMS OTP verification, then choose a new password.
- OTP-verified pre-login support remains separate from account sign-in.

## 2. Razorpay live credentials

Keep the existing live Razorpay account and values. In Render Environment, confirm these existing secrets are present; do not put them in frontend code:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TTIsGpwDtJmgi5`
- `RAZORPAY_SUBSCRIPTION_AMOUNT_PAISE=39900`
- `LISTENER_SUBSCRIPTION_CREDIT_PAISE=5000`

Wallet plans now use Razorpay Standard Web Checkout directly from the wallet page. The browser creates the order through `/api/create-order`, calls `new Razorpay(options).open()`, and sends the result to `/api/verify-payment`. There is no wallet redirect, payment link, `short_url`, hosted checkout URL, or separate `checkout.html`.

Closing Checkout leaves the customer on the wallet page. A successful payment adds talk time only after server-side signature, order, amount, currency, payment-status, and capture verification. Razorpay controls its secure mobile payment-method UI, including the responsive “More Options” view; We Met does not navigate the browser away from the wallet.

### Checkout branding

The project sends the We Met name, logo, pink `#E62D7D` action colour, and dark backdrop. Razorpay-hosted card, UPI, bank, and wallet controls cannot be restyled with site CSS.

To adjust provider-owned styling, use **Razorpay Dashboard → Account & Settings → Checkout Styling** in the same live account.

## 3. Signed membership webhook

Create or retain the webhook at:

    https://YOUR-DOMAIN/api/subscriptions/webhook

Paste the identical webhook secret into `RAZORPAY_WEBHOOK_SECRET`. The server validates `X-Razorpay-Signature` against the original raw body, records event IDs idempotently, activates access only after verified payment, and credits the listener once per qualifying payment.

## 4. Production checklist

- Keep Razorpay Test and Live keys, plans, and webhooks in matching modes.
- Test wallet amounts such as ₹49 and ₹99: open, cancel, retry, successful capture, and browser Back.
- Confirm the URL stays on the wallet page while Standard Checkout is open and after it closes.
- Confirm talk time changes only after `/api/verify-payment` succeeds.
- Test new-account OTP signup, password-only returning-user login, and MSG91 OTP password reset for both customer and listener accounts.
- Confirm the admin navigation has no password-reset approval queue.
- Test one membership, renewal, cancellation, failed payment, exclusive post access, and direct messaging.
- Add a production TURN service for reliable calls across restrictive mobile networks.
- Keep PostgreSQL backups and rotate any exposed secret immediately.

Official references:

- Razorpay Standard Checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay Checkout Styling: https://razorpay.com/docs/payments/dashboard/account-settings/checkout-styling/
- Razorpay payment webhooks: https://razorpay.com/docs/webhooks/payments/
- MSG91 OTP Widget: https://docs.msg91.com/otp-widget

