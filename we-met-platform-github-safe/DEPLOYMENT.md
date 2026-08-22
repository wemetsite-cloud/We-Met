# We Met v6.8.1 deployment

Deploy the repository root with `render.yaml`. The supported same-origin staff URLs are:

- Admin: `https://wemet.xyz/admin/`
- Listener: `https://wemet.xyz/listener/`
- Legacy listener alias: `https://wemet.xyz/employee/`

These path-based URLs work without separate subdomain routing and should be used until the staff subdomains are healthy.

## Required Render settings

Keep the existing environment variables configured in the Render service. In particular, do not put `JWT_SECRET`, `ADMIN_PASSWORD`, `DATABASE_URL`, or `RAZORPAY_KEY_SECRET` in frontend files. The current Razorpay key starts with `rzp_test_`, so payments remain in Razorpay test mode until both server-side Razorpay variables are replaced with live credentials.

## Optional staff subdomains

To use `admin.wemet.xyz` and `listener.wemet.xyz`, add both as custom domains on the same Render web service, then point their Cloudflare DNS records to the hostname Render provides. Remove any Cloudflare Origin Rule that sends either hostname to a different origin or port. Wait until Render shows the custom domain certificate as active before using those URLs.

## After deployment

1. Open `https://wemet.xyz/api/health` and confirm it returns `ok: true`.
2. Open the admin and listener path URLs above.
3. Refresh each portal once after deploying v6.8.1 so the new service worker replaces the old cache.
4. Confirm one tap changes a page or tab and that a temporary network interruption does not sign the user out.
