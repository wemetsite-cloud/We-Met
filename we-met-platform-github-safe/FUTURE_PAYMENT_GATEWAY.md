# Future automatic payment-gateway upgrade

V5 uses manual UPI payment-proof submission. Customers choose a pack, pay the configured UPI ID and upload a screenshot. The administrator independently verifies the transaction and then approves or declines it. Approval is transaction-locked and credits minutes once.

Reserved private fields are present in `backend/.env.example`:

```env
PAYMENT_GATEWAY_MODE=manual-proof
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

The Razorpay values are placeholders only; setting them does not activate an automatic gateway. A future release must add server-created orders, server-side signature verification, idempotent wallet credit, webhook verification, failed/cancelled payment handling, invoices and legal/tax review. Never trust browser-supplied prices or approve a screenshot without checking the receiving account.
