# We Met Razorpay setup

V5.9 ships with temporary `upi_direct` mode enabled by default so the site
can hand customers to Google Pay or another UPI app while KYC is pending. Follow
`UPI_DIRECT_DEPLOY_NOW.md` for that manually verified flow. After Razorpay Live Mode is
unlocked, We Met can switch to Razorpay Standard Checkout. The backend creates every order from
the selected database plan, verifies the Checkout signature on the server,
confirms that the payment is captured, and credits the wallet once. Screenshots
and manual approval are not part of the Razorpay-mode flow.

## Information required

You do not need to share your Razorpay login, password, OTP, PAN, Aadhaar or bank
login with a developer. Configure these three values privately in Render:

```text
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
```

- Get the Key ID and Key Secret from Razorpay Dashboard > Account & Settings >
  API Keys. Start with Test Mode.
- Create the webhook secret yourself. Use a private random value of at least 16
  characters; 32 or more is recommended.
- Never put the Key Secret or webhook secret in customer-site files, GitHub,
  screenshots or chat. The Key ID is sent to Checkout, but the other two values
  must remain server-only.

## Render environment variables

Open the We Met web service in Render, choose Environment, and add:

```text
PAYMENT_GATEWAY_MODE=razorpay
RAZORPAY_KEY_ID=your_test_or_live_key_id
RAZORPAY_KEY_SECRET=your_matching_key_secret
RAZORPAY_WEBHOOK_SECRET=your_private_webhook_secret
PUBLIC_URL=https://wemet.xyz
ALLOWED_ORIGINS=https://wemet.xyz,https://www.wemet.xyz
```

Save the values and redeploy. Test and Live keys cannot be mixed.

## Razorpay webhook

In the matching Razorpay mode (Test first), add this webhook URL:

```text
https://wemet.xyz/api/webhooks/razorpay
```

Enter exactly the same webhook secret stored in Render. Enable these events:

```text
payment.captured
payment.failed
payment.authorized
```

`order.paid` is also supported, but `payment.captured` is sufficient for wallet
credit. Duplicate or out-of-order webhook delivery is handled safely.

## Payment capture

In Razorpay Dashboard > Account & Settings > Payment Capture, enable automatic
capture. We Met adds minutes only after the payment status is `captured`; an
`authorized` payment remains pending and is not treated as paid.

## Test before going live

1. Keep Razorpay in Test Mode and use `rzp_test_...` keys.
2. Sign in as a customer and choose a talk-time pack.
3. Complete one simulated success and one simulated failure.
4. Confirm a successful payment appears as `paid` in the customer wallet and
   admin Payments page.
5. Confirm the minutes and wallet ledger are added once, even after refreshing.
6. Confirm Razorpay shows successful webhook delivery.

Test Mode is simulated and does not move real money.

## Go live

Complete Razorpay account activation/KYC and settlement-bank setup first. Then:

1. Switch Razorpay Dashboard to Live Mode.
2. Generate Live API keys.
3. Create the same webhook in Live Mode with a strong secret.
4. Replace all three Render Razorpay values together.
5. Redeploy and make one small real payment end to end.

UPI Collect by manually entering a UPI ID was deprecated for most businesses in
2026. Razorpay Standard Checkout presents the payment methods enabled for the
account, including supported UPI Intent/QR flows.

## Safety built into this version

- The browser never decides the price or number of minutes.
- The Key Secret and webhook secret stay on the backend.
- Checkout signatures are verified with the server-stored order ID.
- Payment ID, order ID, amount, currency and captured status are checked.
- Signed webhook bodies are verified before processing.
- Webhook events and wallet credits are idempotent, so retries cannot add the
  same minutes twice.
- Existing direct-UPI and older transfer records remain visible to the admin for history.
