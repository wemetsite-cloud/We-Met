# Deploy We Met now with direct UPI

We Met V5.9 is configured for `upi_direct` by default. Customers choose a pack, tap Google Pay or **Choose any UPI app**, and receive the payee, exact amount, currency and unique checkout reference inside the payment app. A desktop customer can scan the exact-amount QR.

This is a temporary, manually verified payment flow while Razorpay Live Mode is unavailable. It does not bypass UPI, bank or account receive limits. If the configured receiving UPI ID is limited, replace it with another eligible working UPI ID or wait/contact the bank. Changing the website button or QR cannot make a limited destination receive money.

## Private Render settings

Add these under **Render → Service → Environment**:

```text
PAYMENT_GATEWAY_MODE=upi_direct
UPI_PAYMENT_PAYEE_NAME=the exact receiver name shown by the UPI app
UPI_PAYMENT_ID=your working receiving UPI ID
UPI_PAYMENT_INTENT_MINUTES=1440
```

Do not put the real UPI ID, database URL, passwords or private keys in GitHub source files. Keep the existing `DATABASE_URL`, `JWT_SECRET`, admin/listener passwords, public URL, allowed origins and VAPID values. Redeploy after saving the settings.

Use a receiving account and UPI ID that your bank/provider permits for your commercial use. Google Pay's current help page says business acceptance should use an individual current account and that transaction limits can be set by NPCI, the bank and Google: <https://support.google.com/pay/india/answer/7314750?hl=en>

## Customer flow

1. Customer signs in and chooses a talk-time pack.
2. The server creates an authenticated, expiring intent using the plan price stored in PostgreSQL.
3. Customer taps **Pay with Google Pay**, **Choose any UPI app**, or scans the QR.
4. Customer checks the receiver name and exact amount in the UPI app, completes payment there, and returns to We Met.
5. Customer submits the successful UPI transaction ID/UTR. A screenshot is optional.
6. The payment remains **pending** until an administrator independently finds the same amount and transaction ID in the receiving UPI app or bank statement.
7. Approval credits the wallet once. Duplicate references and repeated approvals are blocked transactionally.

Google documents its web UPI fields and Google Pay app handoff here: <https://developers.google.com/pay/india/api/web/create-payment-method> and <https://developers.google.com/pay/india/api/web/pay-ui>

## Required admin check

Open **Admin → Payments**. Before approving:

1. Open the receiving UPI app or bank statement independently.
2. Match the exact amount.
3. Match the complete UPI transaction ID/UTR.
4. Check that it has not already been approved.
5. Type the requested last four reference characters and approve.

Never approve from a screenshot alone. A client-side app redirect cannot prove settlement.

## Test before sharing the site

1. Deploy and sign in as a customer on an Android phone.
2. Choose a pack and confirm that Google Pay opens with the correct payee and exact amount.
3. Cancel without paying and confirm that no minutes are added.
4. Make one small real payment to a receiving UPI ID you control.
5. Submit its real transaction ID.
6. Confirm it appears as pending in Admin with the customer's name, email and phone.
7. Match the receiving record, approve once, and confirm the minutes appear once.
8. Try approving again and reusing the same reference; both must be rejected.
9. Test the header Back button, Android browser Back and modal Back throughout checkout.

## Switch to Razorpay later

After Razorpay KYC is complete and Live Mode is available:

1. Follow `RAZORPAY_SETUP.md`.
2. Add one matching set of Live Key ID, Live Key Secret and webhook secret in Render.
3. Configure the signed webhook and automatic capture.
4. Change `PAYMENT_GATEWAY_MODE=razorpay` and redeploy.

Existing direct-UPI records remain in customer and admin history.
