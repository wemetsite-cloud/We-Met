# We Met V5.2 — publish-ready package

We Met is a responsive platform for private Malayalam browser voice conversations. The interface is English. Customer, listener and admin portals remain separate frontends with their own HTML, JavaScript, CSS and assets.

## Start here

For local setup and publishing, read:

```text
PUBLISH_STEP_BY_STEP.md
```

Windows shortcuts:

```text
SETUP_WINDOWS.bat
START_WINDOWS.bat
MAKE_SAFE_GITHUB_COPY_WINDOWS.bat
```

## Applications

- `customer-site/` — customer landing page, wallet, manual UPI proof submission, voice call, reliable chat, recovery and installable PWA
- `employee-site/` — listener login, availability, incoming calls, voice call, reliable chat, recovery and installable PWA
- `admin-site/` — users, listeners, calls, plans, payment verification, recovery approvals, coupons, safety, support and installable PWA
- `backend/` — Express, PostgreSQL/Supabase, Socket.IO and WebRTC signalling

## V5 improvements

- V5.2 cache refresh: customer, listener and admin use network-first service workers, versioned assets and automatic one-time reload after deployment
- Guided purchase checkout with a dedicated Google Pay link, universal UPI app chooser and exact-amount QR code
- Screenshot preview before submission and a live verification screen that continues updating after the customer returns to the wallet
- Automatic wallet refresh when the administrator approves a payment, with decline messages shown directly to the customer

- local `.env` and `node_modules` removed from the distributed package
- secret-safe GitHub copy generator
- stricter production configuration validation
- automatic use of Render's public URL
- automatic idempotent database initialization before production startup
- deterministic `npm ci` deployment
- one-instance configuration for the current real-time call runtime
- Singapore Render region
- root/subdomain-aware portal routing
- Docker secret exclusions
- exposed temporary passwords removed from package documentation and defaults
- fixed in-call chat correlation and added delivery acknowledgement
- customer pack selection, UPI deep link and screenshot upload to `salahkpsite@slc`
- transaction-locked approval/decline so one payment cannot credit minutes twice
- recovery key, request tracking, admin approval and customer/listener password completion
- install manifests and offline app shells for all three portals

## Live paths before buying a domain

```text
Customer: https://YOUR-SERVICE.onrender.com/
Listener: https://YOUR-SERVICE.onrender.com/employee/
Admin:    https://YOUR-SERVICE.onrender.com/admin/
Health:   https://YOUR-SERVICE.onrender.com/api/health
```

## Important

Manual UPI proof verification, coupon codes and manual admin wallet credits are active. The administrator must verify every submitted transaction independently in the receiving UPI account before approval. This is not an automatic payment gateway.

Use a paid always-on server and a TURN relay before serving real customers. Keep this version on one server instance until shared multi-instance call state is implemented.
