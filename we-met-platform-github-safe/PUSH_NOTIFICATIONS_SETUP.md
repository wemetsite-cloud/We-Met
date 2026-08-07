# We Met notification-bar alerts

We Met uses standards-based Web Push. A signed-in listener can receive an
incoming-call alert in the device notification bar while the site is in the
background. Customers can receive payment and administrator updates after they
opt in. In-app Socket.IO notifications remain available when push is unsupported.

## 1. Generate one VAPID key pair

Install the backend packages first, then run:

```text
npm --prefix backend install
npm --prefix backend run push:keys
```

The command prints a matching public/private pair. Generate it once for the
production service and keep using the same pair. Rotating VAPID keys invalidates
existing browser subscriptions, so users would need to enable alerts again.

## 2. Configure the server

Add these values to `backend/.env` for local testing and to the Render service
Environment for production:

```text
VAPID_PUBLIC_KEY=the_generated_public_key
VAPID_PRIVATE_KEY=the_generated_private_key
VAPID_SUBJECT=mailto:wemetsite@gmail.com
```

`VAPID_PRIVATE_KEY` is server-only. Never put it in frontend JavaScript, GitHub,
screenshots or chat. The public key is intentionally returned to signed-in
browsers so they can create a push subscription.

`SETUP_WINDOWS.bat` generates a matching pair automatically in the local
`backend/.env`. Copy those same two values into Render when the Blueprint asks
for them.

## 3. HTTPS and permission behaviour

Production Web Push requires a secure HTTPS origin and a supported browser.
Permission is requested only from an explicit user action:

- listener: **Enable call alerts** or **Go online**
- customer: **Enable alerts**, including the prompt shown after a successful top-up

If a user blocks notifications, We Met continues to ring and show updates while
the page is open. The browser controls whether permission can be requested
again; the user may need to change the site permission in browser settings.

## 4. Test before launch

1. Deploy with the three VAPID values and HTTPS.
2. Sign in to the listener portal and choose **Enable call alerts**.
3. Put the listener PWA/browser tab in the background.
4. From a customer account with talk-time, call that listener.
5. Confirm the notification bar shows the incoming call and tapping it focuses
   the listener portal.
6. Complete a Razorpay Test Mode payment and enable customer payment alerts.
7. Send a message from Admin → Notifications and confirm it reaches opted-in
   users both in-app and in the notification bar.

References: <https://developer.mozilla.org/en-US/docs/Web/API/Push_API> and
<https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification>.
