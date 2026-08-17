# We Met v6.3.0 deployment notes

- Customer payment UI redesigned as a premium UPI checkout.
- Google Pay and Other UPI app launch buttons added.
- QR is generated black on white at 512px with high error correction.
- Customer pages no longer display the number of active/available listeners.
- The listener discovery section is hidden when no listener has a live connection.
- ₹1999 Long Connect is 240 minutes (14,400 seconds).
- Listener wallet earnings remain calculated from connected seconds using each listener’s administrator-set per-minute rate.
- Receiving UPI example/default for deployment: `paytm.s3hc53w@pty`. Keep `UPI_PAYMENT_PAYEE_NAME` set to the exact merchant/payee name shown by the receiving account.
