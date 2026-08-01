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
- [ ] Review the minimum-age and consent model with qualified professionals.

This release does **not** store voice recordings. Admin call records contain metadata only: participants, status, start/end time, billed duration and end reason. Live text messages are stored for operating and moderating the service.

## Payments and recovery

- [ ] Confirm `PAYMENT_UPI_ID=salahkpsite@slc` belongs to the intended receiving account.
- [ ] Check the receiving UPI account independently before approving every screenshot.
- [ ] Never approve based only on a screenshot, browser text or customer-supplied UTR.
- [ ] Test approve, decline, duplicate-review prevention and minute credit history.
- [ ] Verify account ownership using information already on record before approving password recovery.
- [ ] Keep PostgreSQL backups because payment screenshots and approval records are stored in the database.

## Infrastructure

- [ ] Upgrade from a sleeping free service to an always-on paid instance before real use.
- [ ] Keep the service at one instance until shared Socket.IO/call state is implemented.
- [ ] Use HTTPS on every domain.
- [ ] Enable database backups.
- [ ] Configure uptime and error monitoring.
- [ ] Add hosting-layer rate limits and abuse protection.
- [ ] Review logs regularly without exposing secrets or personal data.
- [ ] Test database restore procedures.
