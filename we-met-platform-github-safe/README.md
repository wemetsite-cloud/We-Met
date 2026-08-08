# We Met V5.17 — payment-verification-ready application

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

- `customer-site/` — customer landing page, dual-mode payment checkout, wallet, voice call, reliable chat, recovery and installable PWA
- `employee-site/` — listener login, availability, incoming calls, voice call, reliable chat, recovery and installable PWA
- `admin-site/` — users, listeners, calls, plans, UPI verification, Razorpay history, recovery approvals, coupons, safety, support and installable PWA
- `backend/` — Express, PostgreSQL/Supabase, Socket.IO and WebRTC signalling

## V5.17 verification-readiness improvements

- public About, Contact, Pricing, Service Delivery, Terms, Privacy, Refund & Cancellation, and Community Guidelines pages
- server-controlled talk-time prices visible before sign-in
- clear 18+ digital-service description, no physical shipping, billing and refund disclosures
- public footer with verification-relevant business and policy links
- customer directory now shows only real connected listener accounts; demo/test profiles stay private in admin
- removed stale nested copies of backend/admin/employee/customer projects from inside `customer-site/`, preventing them from being accidentally served as public static files
- added `robots.txt`, `sitemap.xml`, and a fresh 5.17 cache version
- added `PAYU_VERIFICATION_READINESS.md` explaining the remaining PayU category-risk issue

## V5.11 QR-only checkout and interface polish

- customers see only the exact-amount UPI QR, receiving UPI ID and verified payee name
- no Google Pay, universal UPI or browser-to-app redirect URL is returned to the customer
- customers can copy the UPI ID or save the QR for a payment app's **Scan from gallery** option
- the exact amount remains server-controlled and every payment still requires a unique transaction ID/UTR
- customer, listener and admin top Back controls are compact icon-only buttons with accessible labels
- the admin control centre now uses the We Met rose theme, responsive cards, sticky forms and bounded touch-friendly tables
- mobile overlays, lists, forms, tables and active-call screens respect dynamic viewport and safe-area sizes
- obsolete duplicate deployment notes were removed from the publish package

## V5.9 improvements

- deploy-now `upi_direct` mode with an exact-amount QR and copyable UPI ID
- signed-in-only receiving UPI details supplied from private server environment variables
- expiring, server-priced payment intents so plan amount and talk-time cannot be changed in the browser
- required UTR/transaction reference, duplicate-reference protection and optional 3 MB image upload
- admin approval requires matching the amount and transaction ID in the receiving UPI app or bank statement
- transactional one-time wallet credit with customer/admin notifications
- one-setting switch to the existing secure Razorpay flow after KYC and Live Mode activation
- Razorpay Checkout loads only when Razorpay mode is enabled
- direct-UPI and Razorpay records remain together in customer and admin history
- rose Back controls on every non-home customer, listener and admin screen
- History API state for tabs, payment/legal/auth overlays and active-call minimising, so Back stays inside the app
- direct UPI payments are clearly labelled as administrator-verified, while screenshots are never treated as settlement confirmation
- Web Push subscriptions with server-side VAPID delivery for background notification-bar alerts
- incoming listener calls use urgent, persistent notification tags and open the listener PWA when tapped
- customer payment/admin messages can reach the notification bar after opt-in
- phone is required for new customer accounts, can be securely updated by existing customers, and appears in admin search, details and payments
- refreshed rose checkout presentation, automatic capture confirmation and clearer failure/cancellation states

- Razorpay Standard Checkout with server-created Orders
- server-side Checkout signature and captured-payment verification
- signed, idempotent webhook handling for captured, authorised and failed payments
- automatic one-time wallet credit with customer notification
- Test/Live configuration through private environment variables
- Razorpay transaction history in both customer and admin portals
- direct-UPI and older transfer records remain available for customer/admin audit history

- V5.3 registration uses one required 18+ / Terms / Privacy confirmation and no date-of-birth field
- Talk-time packs use a responsive 2-column mobile, 3-column tablet and 4-column large-screen grid
- Admin overview shows unique concurrently connected users with customer/listener counts and refreshes automatically
- Customer directory has a bounded, touch-friendly mobile scroller with a sticky table header
- Customer, listener and admin use network-first service workers, versioned assets and automatic one-time reload after deployment
- Secure Checkout supports the payment methods Razorpay enables for the merchant account
- Automatic wallet refresh when a captured payment is confirmed

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
- customer pack selection with server-controlled prices and durations
- transaction-locked, idempotent credit so one Razorpay order cannot add minutes twice
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

For immediate direct-UPI deployment, read `UPI_DIRECT_DEPLOY_NOW.md`. A limited receiving UPI ID cannot be fixed or bypassed in website code; use an eligible working UPI ID or contact the bank/provider. Razorpay Test Mode cannot receive real customer money; after KYC unlocks Live Mode, follow `RAZORPAY_SETUP.md`, configure the signed webhook, enable automatic capture and change the payment-mode environment variable. Configure `PUSH_NOTIFICATIONS_SETUP.md` with one persistent VAPID key pair so customers and listeners can opt into notification-bar alerts. Coupon codes and manual admin wallet adjustments remain available.

Use a paid always-on server and a TURN relay before serving real customers. Keep this version on one server instance until shared multi-instance call state is implemented.
