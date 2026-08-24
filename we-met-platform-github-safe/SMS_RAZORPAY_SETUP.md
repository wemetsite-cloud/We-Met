# SMS OTP and Razorpay setup

## 1. Where to paste the SMS API key

Do not paste an SMS secret into HTML, JavaScript, `config.js`, or GitHub. The included `render.yaml` already declares secret placeholders.

For Fast2SMS, open **Render Dashboard → we-met-platform → Environment**, then set:

- `SMS_ENABLED=true`
- `SMS_PROVIDER=fast2sms`
- `FAST2SMS_API_KEY=YOUR_FAST2SMS_AUTHORIZATION_KEY`
- `FAST2SMS_OTP_TEMPLATE_ID=YOUR_APPROVED_OTP_TEMPLATE_ID`
- `SMS_OTP_EXPIRY_MINUTES=10`

Save the environment and redeploy. The project intentionally sends Fast2SMS messages only to `+91` numbers. Complete Fast2SMS KYC and approve the OTP/DLT template before live testing.

For Twilio instead, set `SMS_ENABLED=true`, `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` in the same Render Environment screen.

`SMS_TEST_OTP` is for local development only and is ignored when `NODE_ENV=production`.

### SMS flows included

- OTP registration for customers and listeners.
- Optional SMS OTP sign-in for returning customers and listeners.
- SMS OTP password reset for customers and listeners.
- OTP-verified pre-login support.
- No administrator approval or recovery key is used for password reset.

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
- Test SMS signup, SMS OTP login, and SMS password reset for both customer and listener accounts.
- Confirm the admin navigation has no password-reset approval queue.
- Test one membership, renewal, cancellation, failed payment, exclusive post access, and direct messaging.
- Add a production TURN service for reliable calls across restrictive mobile networks.
- Keep PostgreSQL backups and rotate any exposed secret immediately.

Official references:

- Razorpay Standard Checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay Checkout Styling: https://razorpay.com/docs/payments/dashboard/account-settings/checkout-styling/
- Razorpay payment webhooks: https://razorpay.com/docs/webhooks/payments/
- Twilio Messaging API: https://www.twilio.com/docs/messaging/api

