# We Met V4.1 — publish-ready package

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

- `customer-site/` — customer landing page, account, listener selection, coupon wallet, voice call, chat and PWA
- `employee-site/` — listener login, availability, incoming calls, voice call, chat and history
- `admin-site/` — users, listeners, calls, plans, coupons, support, reports, suspensions and analytics
- `backend/` — Express, PostgreSQL/Supabase, Socket.IO and WebRTC signalling

## Publish-ready improvements

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

## Live paths before buying a domain

```text
Customer: https://YOUR-SERVICE.onrender.com/
Listener: https://YOUR-SERVICE.onrender.com/employee/
Admin:    https://YOUR-SERVICE.onrender.com/admin/
Health:   https://YOUR-SERVICE.onrender.com/api/health
```

## Important

Coupon codes and manual admin wallet credits are active. Real online payment checkout is intentionally disabled.

Use a paid always-on server and a TURN relay before serving real customers. Keep this version on one server instance until shared multi-instance call state is implemented.
