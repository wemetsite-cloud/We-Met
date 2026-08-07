# Security and launch checklist

## Accounts and secrets

- [ ] Reset the Supabase database password that was previously shared.
- [ ] Let Render generate a unique production JWT secret.
- [ ] Use new private admin and listener passwords during safe setup.
- [ ] Keep `backend/.env` out of GitHub and public uploads.
- [ ] Restrict access to the admin subdomain.

## Calling

- [ ] Configure a production TURN service.
- [ ] Test calls across different networks and devices.
- [ ] Confirm billing starts only after both participants report media ready.
- [ ] Confirm billing stops immediately when the call ends.
- [ ] Confirm low-balance warning and zero-balance disconnect.
- [ ] Confirm retry never rings a listener already tried for the same request.

## Moderation and privacy

- [ ] Verify every listener’s identity and train them on prohibited behaviour.
- [ ] Publish Terms, Privacy, Safety and Refund/Wallet policies.
- [ ] Create a process for reports, support requests and emergency escalation.
- [ ] Confirm customer contact details are never displayed to listeners.
- [ ] Restrict customer phone/email access to authorised administrators and support use.
- [ ] Review the minimum-age and consent model with qualified professionals.

This release does **not** store voice recordings. Admin call records contain metadata only: participants, status, start/end time, billed duration and end reason. Live text messages are stored for operating and moderating the service.

## Payments and recovery

- [ ] Confirm the beneficiary name, bank account number and IFSC from an official bank statement before deployment.
- [ ] Confirm the receiving account is permitted for the expected type and volume of customer/business receipts.
- [ ] Keep beneficiary values in private server environment variables, not GitHub source.
- [ ] Confirm the configured receiving UPI ID can accept the expected commercial payments; if it reports a limit, replace it with another eligible working destination or contact the bank/provider.
- [ ] For every pending direct transfer, match the full UTR/reference and exact amount in the receiving bank statement.
- [ ] Never approve from a screenshot, SMS, customer claim or browser display alone.
- [ ] Test duplicate UTR rejection and confirm one approval creates only one wallet credit.
- [ ] Complete Razorpay account activation/KYC and settlement-bank verification.
- [ ] Keep the Razorpay Key Secret and webhook secret only in private server environment variables.
- [ ] Configure `https://wemet.xyz/api/webhooks/razorpay` with the matching secret.
- [ ] Enable automatic payment capture and credit talk-time only for `captured` payments.
- [ ] Test success, failure, delayed webhook, duplicate webhook and one-time minute credit in Test Mode.
- [ ] Replace all Test values together when switching to Live Mode; never mix Test and Live keys.
- [ ] Verify account ownership using information already on record before approving password recovery.
- [ ] Keep PostgreSQL backups because payment orders, references and wallet records are stored in the database.

## Notification-bar alerts

- [ ] Configure one persistent VAPID pair in Render and keep the private key server-only.
- [ ] Test listener incoming-call alerts while the installed PWA is backgrounded.
- [ ] Test customer captured-payment and administrator alerts after opt-in.
- [ ] Confirm notification permission is requested only from a user action and denial does not block in-app use.

## Infrastructure

- [ ] Upgrade from a sleeping free service to an always-on paid instance before real use.
- [ ] Keep the service at one instance until shared Socket.IO/call state is implemented.
- [ ] Use HTTPS on every domain.
- [ ] Enable database backups.
- [ ] Configure uptime and error monitoring.
- [ ] Add hosting-layer rate limits and abuse protection.
- [ ] Review logs regularly without exposing secrets or personal data.
- [ ] Test database restore procedures.
