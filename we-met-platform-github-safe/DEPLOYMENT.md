# We Met v8.9.18 deployment

This package contains the customer site, listener workspace, admin portal, Node.js API/Socket.IO server and PostgreSQL schema.

## Portal URLs

When `SERVE_FRONTENDS=true`, one deployment serves:

- Customer: `https://wemet.xyz/`
- Listener: `https://wemet.xyz/employee/` (alias: `/listener/`)
- Admin: `https://wemet.xyz/admin/`
- Health: `https://wemet.xyz/api/health`

## Render

1. Connect the repository root to Render and a PostgreSQL database.
2. Deploy with `render.yaml` or keep the equivalent existing Web Service settings.
3. In **Environment**, keep all private values out of GitHub/frontend files.
4. Required authentication secret: `MSG91_AUTH_KEY=<WEMETSERVER Authkey>`.
5. Keep `SMS_ENABLED=false` for this MSG91 Widget build.
6. Keep the existing Razorpay and database/JWT/admin secrets.
7. For reliable WebRTC on restrictive networks, configure `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
8. Redeploy and wait for **Live**.
9. Confirm `/api/health` before testing the portals.

The start command runs the idempotent database initialization before the server starts.

## Listener verification

A new listener cannot use the workspace until voice approval:

`OTP registration → Open Listener App → full-page voice recording → Send for verification → pending review → Admin approval → workspace`

Admin can edit the Malayalam reading sentence under the verification section. The listener page fetches and displays that saved sentence. While verification is not approved, normal listener workspace API routes remain blocked, while the verification GET/audio-upload routes remain available.

## Authentication

- New customer/listener: MSG91 OTP once, then create password.
- Returning customer/listener with the same role + phone: password login.
- Forgot password: MSG91 OTP, then set a new password.
- Pre-login support: MSG91 verification before submitting the issue.

## Release checks

Test on phone, tablet and desktop after every production deployment. Use an Incognito window once after a cache-version change.

- fixed customer bottom navigation;
- listener discovery/profile pages;
- 6-column desktop wallet packs and responsive tablet/mobile grids;
- customer account/security actions;
- listener login, voice verification, pending/approved states;
- listener desktop tabs, online/offline/break;
- calls, WebRTC audio, ring/accept/reject/end/busy;
- reports/support;
- Razorpay wallet top-up and exclusive membership;
- listener posts/messages/earnings/profile;
- admin verification approval and operational pages.
