# We Met v8.8.0 deployment

This package contains the customer site, listener workspace, operations portal, API server and PostgreSQL schema. It contains no online payment gateway, checkout SDK, order endpoint, verification endpoint or payment webhook.

## Portal URLs

When `SERVE_FRONTENDS=true`, one deployment serves:

- Customer: `https://wemet.xyz/`
- Listener: `https://wemet.xyz/listener/`
- Operations: `https://wemet.xyz/admin/`
- Health check: `https://wemet.xyz/api/health`

## Deploy on Render

1. Create or connect a PostgreSQL database.
2. Deploy the repository root using `render.yaml`.
3. Enter every environment value marked `sync: false`.
4. Follow `SMS_SETUP.md` if SMS OTP delivery is required.
5. Deploy again and confirm `/api/health` returns `{"ok":true}`.

The start command runs the idempotent database schema before the server starts. Keep database backups enabled before production releases.

## Required production secrets

- `DATABASE_URL`
- `JWT_SECRET` — private random value with at least 48 characters
- `ADMIN_PASSWORD` — at least 10 characters
- The SMS credentials for the selected provider, when SMS is enabled

## Local start

1. Add the required values to a private `.env` file.
2. Run `npm run install:backend`.
3. Run `npm run db:init`.
4. Run `npm start`.

## Release checks

1. Register and sign in as a customer.
2. Confirm listener discovery, following, calling, history, support and redeem codes work.
3. Confirm the Wallet contains no purchase button and no checkout page opens.
4. Confirm listener and operations portals still load.
5. Confirm every customer page loads the privacy guard and that print, context-menu and app-switching protections work.
6. Refresh each portal once so the v8.8.0 service workers replace older cached files.

If the previous production deployment had externally recurring charges, disable those at the former provider before deploying this no-gateway build. This source code no longer communicates with any payment provider.
