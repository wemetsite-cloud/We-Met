# SMS OTP and Razorpay setup

## 1. Choose one SMS provider

The server generates the OTP, stores only a hash, limits attempts and expires each challenge. SMS credentials belong only in the Render environment—never in frontend files or GitHub.

### Fast2SMS for Indian numbers

1. Complete Fast2SMS KYC and create an approved OTP template.
2. In Render → We Met service → **Environment**, set:
   - **SMS_ENABLED=true**
   - **SMS_PROVIDER=fast2sms**
   - **FAST2SMS_API_KEY** to the authorization key
   - **FAST2SMS_OTP_TEMPLATE_ID** to the approved template ID
3. Keep **SMS_OTP_EXPIRY_MINUTES=10**, save and redeploy.

Fast2SMS in this project is intentionally limited to +91 numbers.

### Twilio for international numbers

1. Buy or verify a Twilio SMS-capable sender and complete any country-specific registration.
2. In Render, set:
   - **SMS_ENABLED=true**
   - **SMS_PROVIDER=twilio**
   - **TWILIO_ACCOUNT_SID**
   - **TWILIO_AUTH_TOKEN**
3. Set either **TWILIO_FROM_NUMBER** in E.164 format or **TWILIO_MESSAGING_SERVICE_SID**.
4. Save, redeploy, and test India plus every other country you plan to support.

The login country selector defaults to India but stores every accepted number in E.164 format. **SMS_TEST_OTP** works only during local development and is ignored when **NODE_ENV=production**.

## 2. Configure Razorpay

In Render → **Environment**, set:

- **RAZORPAY_KEY_ID**
- **RAZORPAY_KEY_SECRET**
- **RAZORPAY_WEBHOOK_SECRET**
- **RAZORPAY_SUBSCRIPTION_PLAN_ID=plan_TTIsGpwDtJmgi5**
- **RAZORPAY_SUBSCRIPTION_AMOUNT_PAISE=39900**
- **LISTENER_SUBSCRIPTION_CREDIT_PAISE=5000**

The plan must be a recurring ₹399 plan in the same Razorpay account and mode as the keys. Each listener gets a separate subscription record. A captured membership unlocks only that listener's exclusive posts and messages.

Calls never require a membership and a membership never includes free calls. Random and direct calls use the customer's main talk-time wallet until its balance reaches zero.

### Match Checkout to We Met

The site keeps the exact wallet or listener-membership summary open underneath Razorpay Standard Checkout. It uses the square We Met PNG logo, pink **#E62D7D** action colour, a **#0C0D10** loading surface and a dark backdrop. Cancelling Checkout returns to the same summary instead of an empty page.

1. Open Razorpay Dashboard → **Account & Settings** → **Checkout Styling**.
2. Upload the We Met logo and use **We Met** as the brand name.
3. Choose background **#17181D** and accent **#E62D7D**. This Dashboard background setting is required to replace Razorpay's white payment-method surface on mobile.
4. Choose rounded borders, a clean font, and enable the trusted-business badge if available.
5. Preview desktop and mobile, save in Test mode, and repeat in Live mode if required.

Secure card, UPI and bank fields are hosted by Razorpay. Browser security prevents the project CSS from redesigning those provider-owned fields. The project now preserves the correct underlying We Met page and controls the branded summary, loading background, logo, description and theme options; **Checkout Styling** controls Razorpay's inner payment-method background.

## 3. Add the signed webhook

Create a Razorpay webhook with this URL:

    https://YOUR-DOMAIN/api/subscriptions/webhook

Use a strong secret and paste the identical value into **RAZORPAY_WEBHOOK_SECRET**. Enable subscription lifecycle events and payment captured, failed and refunded events.

The server validates **X-Razorpay-Signature** against the original raw request body, records webhook event IDs idempotently, activates access only after verified payment, and credits the listener ₹50 only once per qualifying payment.

## 4. Production checklist

- Keep Razorpay Test and Live keys, plans and webhooks in matching modes.
- Test one wallet top-up, one new membership, one renewal, one cancellation and one failed payment.
- Confirm an unsubscribed customer can make a wallet-funded random/direct call but cannot open posts or messages.
- Confirm a captured ₹399 payment unlocks only the selected listener's posts and messages.
- Test both SMS signup and returning-password login.
- Add a production TURN service for reliable calls across restrictive mobile networks.
- Keep PostgreSQL backups and rotate any exposed secret immediately.

Official references:

- Razorpay Standard Checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay Checkout Styling: https://razorpay.com/docs/payments/dashboard/account-settings/checkout-styling/
- Razorpay payment webhooks: https://razorpay.com/docs/webhooks/payments/
- Twilio Messaging API: https://www.twilio.com/docs/messaging/api
- Twilio Message resource: https://www.twilio.com/docs/messaging/api/message-resource
