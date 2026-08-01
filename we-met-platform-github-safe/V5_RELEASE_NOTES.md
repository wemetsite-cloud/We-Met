# We Met V5.0 release notes

## Fixed

- In-call messages now include the active call ID, reach both participants and return a delivery acknowledgement.
- Failed chat delivery keeps the typed message in the input so it can be retried.
- Customer and listener password recovery now has a private recovery key, status tracking, administrator approval/decline and a secure new-password step.

## Manual UPI talk-time payments

1. The customer chooses an active minute pack.
2. The customer pays the exact amount to `salahkpsite@slc` from a UPI app.
3. The customer uploads a PNG, JPEG or WebP screenshot up to 5 MB, with an optional UTR and note.
4. The request appears in **Admin → Payments**.
5. The administrator checks the receiving UPI account independently and then approves or declines.
6. Approval credits the exact plan duration once and creates a wallet-ledger entry. A second review is blocked.
7. The customer receives an in-app notification and can see the payment status and administrator message.

Screenshots are stored in PostgreSQL/Supabase so they survive a Render restart. They increase database storage usage, so backups and a retention policy are important before public launch.

## Password recovery

1. The customer or listener submits the account email.
2. The portal displays and locally saves a private recovery key.
3. The administrator verifies ownership using information already on record, then approves or declines in **Admin → Password resets**.
4. The user pastes/checks the saved key and can choose a new password only after approval.
5. Recovery expires after 72 hours and invalidates existing sessions when completed.

## Installable apps

Customer, listener and admin portals now each include a manifest, 192/512 icons, standalone display settings and a service worker. Install requires HTTPS in production (or localhost during development).

## Verification completed

- JavaScript syntax, HTML ID wiring, manifests and required workflow invariants
- clean production dependency install and dependency security audit
- fresh database schema, repeat/idempotency check and V4.1-to-V5.0 migration
- customer, listener and admin UI boot checks
- real Socket.IO customer/listener call-chat delivery and database persistence
- API-level screenshot upload, protected proof viewing, one-time minute credit, recovery approval and password completion
