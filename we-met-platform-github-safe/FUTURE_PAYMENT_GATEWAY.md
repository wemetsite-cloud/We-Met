# Future Razorpay upgrade

V4.1 intentionally uses only coupons and manual minute adjustments. The customer UI contains no payment button and no real-money order can be created.

Reserved private fields are present in `backend/.env.example`:

```env
PAYMENT_GATEWAY_MODE=disabled
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

They are placeholders only; setting them does not activate payments. A future release must add server-created orders, server-side signature verification, idempotent wallet credit, webhook verification, failed/cancelled payment handling, invoices and legal/tax review. Never credit minutes from browser-supplied prices.
