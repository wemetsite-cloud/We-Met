# SMS OTP and Razorpay setup

## 1. Enable phone OTP after you receive the SMS API

The project already contains the OTP generation, hashed database challenge, expiry, attempt limit and phone-first registration flow. `backend/src/sms.js` is the only provider adapter.

For Fast2SMS:

1. Complete the Fast2SMS account/KYC and any required recharge.
2. Create or select an approved OTP template in the Fast2SMS dashboard.
3. Copy the API authorization key and the OTP template ID.
4. In Render, open the We Met web service → **Environment**.
5. Paste the API key into `FAST2SMS_API_KEY`.
6. Paste the template/OTP ID into `FAST2SMS_OTP_TEMPLATE_ID`.
7. Set `SMS_ENABLED=true` and keep `SMS_OTP_EXPIRY_MINUTES=10`.
8. Save the variables and redeploy.
9. Test a new customer number and a new listener number on the live HTTPS site.

Do not paste the SMS key into `customer-site`, `employee-site`, `admin-site`, GitHub or any browser JavaScript. The key belongs only in the server environment. `SMS_TEST_OTP` works only in local development and is deliberately ignored when `NODE_ENV=production`.

Provider references:

- Fast2SMS authorization: https://docs.fast2sms.com/reference/authorization
- Fast2SMS send OTP: https://docs.fast2sms.com/reference/send-otp
- Fast2SMS error/KYC guide: https://docs.fast2sms.com/reference/error-code-list

If you choose another SMS provider, replace the request inside `backend/src/sms.js` and keep its `sendOtp(phone, otp, reference)` interface. The rest of the OTP flow does not need to change.

## 2. Configure Razorpay wallet top-ups and exclusive memberships

Use one matching Razorpay key pair for wallet top-ups and subscriptions:

1. In Render → **Environment**, paste the server credentials into `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Keep `RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TTIsGpwDtJmgi5`.
3. Confirm that this Razorpay plan is a recurring ₹399 plan in the same Razorpay mode/account as the key pair.
4. Keep `RAZORPAY_SUBSCRIPTION_AMOUNT_PAISE=39900` and `LISTENER_SUBSCRIPTION_CREDIT_PAISE=5000`.
5. Set `RAZORPAY_SUBSCRIPTION_TOTAL_COUNT` to the maximum number of recurring cycles you want; the package default is 120.

Every listener has a separate local membership record even though the shared Razorpay plan ID defines the ₹399 billing schedule. A captured membership payment unlocks that listener's posts, direct messages and calls for that customer. Calls are never free: the customer must separately buy talk-time and every connected second is deducted from the main wallet.

### Match Razorpay Checkout to the We Met theme

v8.1 first opens a branded confirmation inside the Wallet page, then opens Razorpay Standard Checkout with the We Met logo, pink `#E62D7D` action colour and dark `#0C0D10` backdrop.

For the provider-controlled checkout surface:

1. Open Razorpay Dashboard → **Account & Settings** → **Checkout Styling**.
2. Upload the We Met logo and set the brand name to `We Met`.
3. Choose a dark background close to `#17181D` and the brand/accent colour `#E62D7D`.
4. Select rounded borders, a clean font and enable the trusted-business badge when Razorpay makes it available for the account.
5. Save in Test mode, complete a test wallet payment and a test membership, then repeat the styling in Live mode if Razorpay keeps the modes separate.

Razorpay Standard Checkout is a secure provider-hosted modal. Its payment fields cannot be placed directly inside the Wallet card or restyled with site CSS. The surrounding We Met confirmation, backdrop, name, logo, description and accent are controlled by this project; the remaining checkout styling is controlled from Razorpay Dashboard.

## 3. Add the signed Razorpay webhook

Recurring renewals happen after the first checkout, so the webhook is required for accurate ongoing access and listener credits.

1. In the Razorpay dashboard, create a webhook whose URL is:
   `https://YOUR-DOMAIN/api/subscriptions/webhook`
2. Generate a strong webhook secret in Razorpay.
3. Paste the same value into Render as `RAZORPAY_WEBHOOK_SECRET`.
4. Enable subscription lifecycle events and payment captured/failed/refunded events.
5. Save, redeploy and use Razorpay's webhook test feature.

The server verifies `X-Razorpay-Signature` against the original raw request body, records every webhook event idempotently and credits a listener ₹50 only once for each captured qualifying subscription payment.

Razorpay references:

- Standard Checkout integration: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Checkout Styling: https://razorpay.com/docs/payments/dashboard/account-settings/checkout-styling/
- Subscription integration: https://razorpay.com/docs/payments/subscriptions/integration-guide/
- Webhook validation and testing: https://razorpay.com/docs/webhooks/validate-test/

## 4. Production checklist

- Use test keys and test-mode plan/webhook first; do not mix test and live resources.
- Use HTTPS and keep `ALLOWED_ORIGINS` limited to your real customer, listener and admin domains.
- Confirm the ₹399 plan amount in Razorpay before accepting live payments.
- Verify a renewal webhook updates access and adds exactly one ₹50 listener credit.
- Confirm cancellation turns off auto-renewal while retaining access through the paid period.
- Add a production TURN service for reliable calls across mobile networks and restrictive NATs.
- Keep PostgreSQL backups and rotate API/webhook secrets if they are ever exposed.
