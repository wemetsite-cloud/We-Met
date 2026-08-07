# Deploy We Met with QR + UPI ID payments

We Met V5.11 uses `upi_direct` by default while Razorpay Live Mode is unavailable. Customers receive an exact-amount QR, the receiving UPI ID and the payee name. The website does not open or redirect to Google Pay, PhonePe, Paytm, BHIM or another payment application.

Customers can scan the QR from another device, save it and use **Scan from gallery**, or copy the UPI ID and enter it manually in their trusted UPI application. Direct-UPI payments remain administrator-verified and cannot bypass a bank, account or UPI receive limit.

## Private Render settings

Add or retain these under **Render → Service → Environment**:

```text
PAYMENT_GATEWAY_MODE=upi_direct
UPI_PAYMENT_PAYEE_NAME=the exact receiver name shown by the UPI app
UPI_PAYMENT_ID=your working receiving UPI ID
UPI_PAYMENT_INTENT_MINUTES=1440
```

Do not place a real UPI ID, database URL, password or private key in GitHub source files. Keep them in Render Environment and redeploy after saving changes.

## Customer flow

1. The customer signs in and selects a talk-time pack.
2. The server creates an authenticated, expiring payment intent using the plan price stored in PostgreSQL.
3. The customer scans or saves the QR, or copies the receiving UPI ID.
4. The customer opens a trusted UPI app independently, checks the receiver and pays the exact amount.
5. The customer returns to We Met and submits the successful UPI transaction ID/UTR. A screenshot is optional.
6. The payment stays **pending** until an administrator finds the same amount and transaction ID in the receiving app or bank statement.
7. Approval credits the wallet once. Duplicate references and repeated approvals are blocked transactionally.

## Required administrator check

Open **Admin → Payments** and independently verify all of the following before approval:

1. The transaction is present in the receiving account.
2. The exact amount matches the selected pack.
3. The complete UPI transaction ID/UTR matches.
4. The payment has not already been approved.
5. The requested confirmation characters match before pressing Approve.

Never approve from a screenshot alone. The site never treats displaying or saving a QR as proof of payment.

## Test before sharing

1. Deploy V5.11 and sign in as a customer.
2. Choose a pack and confirm that only the QR, UPI ID and payee name appear—there must be no payment-app redirect button.
3. Confirm the QR carries the correct receiver and exact amount.
4. Make one small real payment to a receiving UPI ID you control.
5. Submit its real transaction ID and confirm it appears as pending in Admin with customer contact details.
6. Match the receiving record, approve once and confirm that minutes are added once.
7. Try approving again and reusing the same transaction ID; both must be rejected.
8. Test the icon Back control, browser Back, payment scrolling and admin tables on a phone.

## Switch to Razorpay later

After Razorpay KYC is complete and Live Mode is available, follow `RAZORPAY_SETUP.md`, configure Live keys and the signed webhook, then change `PAYMENT_GATEWAY_MODE=razorpay` and redeploy. Existing direct-UPI records remain in customer and admin history.
