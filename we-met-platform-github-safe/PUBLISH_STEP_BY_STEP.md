# Publish We Met — complete Windows guide

This package is prepared for a single Render web service. The customer, listener and admin portals remain separate folders and designs, but one backend serves all three. This is the easiest reliable first deployment.

## What was already prepared

- `backend/.env` is not included and is ignored by Git.
- `node_modules` is not included and is ignored by Git.
- `render.yaml` creates one Render Node web service in Singapore.
- Render generates the production JWT secret automatically.
- The app automatically reads Render's public URL.
- The production start command creates/upgrades database tables before the server starts.
- The service is fixed to one instance because live calls currently use in-memory Socket.IO state.
- Customer is served at the main/root hostname.
- `employee.` or `listener.` subdomains serve the listener portal from `/`.
- `admin.` subdomains serve the admin portal from `/`.
- `api.` subdomains expose the API and health endpoint.

---

# PART A — prepare the local database and passwords

## 1. Extract this ZIP into a new clean folder

Do not overwrite the previous folder. Example:

```text
C:\Users\sabit\Documents\we-met-publish-ready
```

## 2. Reset the Supabase database password

This is required because an older database password was shared in chat.

In Supabase:

```text
Your project → Database → Settings → Reset database password
```

Create a new private password and save it in a password manager or private note. Never paste it into chat or GitHub.

## 3. Copy the new Session Pooler URI

In Supabase:

```text
Your project → Connect → Session pooler → URI
```

Copy the complete URI. It starts with `postgresql://` or `postgres://`.

If the URI contains `[YOUR-PASSWORD]`, leave the placeholder there. The setup program will ask for the password separately and URL-encode it safely.

## 4. Run the safe setup

Double-click:

```text
SETUP_WINDOWS.bat
```

It asks for:

1. Supabase Session Pooler URI
2. New admin password
3. The same admin password again
4. New listener password
5. The same listener password again
6. Payment mode: direct transfer now or Razorpay
7. For direct transfer: exact beneficiary name, account number twice, IFSC, optional bank name and optional UPI fallback
8. For Razorpay: matching Test or Live Key ID, private Key Secret and webhook secret

Use completely new passwords. Each account password must contain at least 10 characters. Choose direct transfer until Razorpay Live Mode is available. Razorpay Test Mode is only a simulation and cannot receive real customer money.

The setup then:

- installs exact Node packages from the lockfile
- creates `backend/.env` locally
- generates a private random JWT secret
- generates a matching browser-notification VAPID key pair
- stores either the bank-transfer settings or Razorpay values only in the local backend environment file
- creates/upgrades the Supabase tables
- updates the seeded admin and listener passwords once
- changes `RESET_SEEDED_PASSWORDS` back to `false`

The usernames are already configured:

```text
Admin username: sabithkp
Listener email: gentle8x@gmail.com
```

## 5. Start and test locally

Double-click:

```text
START_WINDOWS.bat
```

Open:

```text
Customer: http://localhost:3000/
Listener: http://localhost:3000/employee/
Admin:    http://localhost:3000/admin/
Health:   http://localhost:3000/api/health
```

The health page must show `"ok": true`.

Test these before publishing:

- admin login
- listener login and Online status
- create a customer account
- create a coupon in admin
- redeem the coupon as customer
- place and accept a call
- test microphone and text chat
- end the call and verify wallet deduction
- if direct transfer is selected, test a real small transfer, submit its reference, match it in the receiving bank statement and approve it once

Keep the new admin and listener passwords private. You will enter the same values in Render.

---

# PART B — create a secret-free GitHub folder

## 6. Create a safe upload copy

Close the running server or leave it open; either is fine. Double-click:

```text
MAKE_SAFE_GITHUB_COPY_WINDOWS.bat
```

It creates a sibling folder named:

```text
we-met-platform-github-safe
```

That folder excludes:

- `backend/.env`
- all `node_modules`
- `.git`
- log files

Upload **only this safe folder** to GitHub.

## 7. Publish it using GitHub Desktop

1. Open GitHub Desktop and sign in.
2. Select `File → Add local repository`.
3. Choose `we-met-platform-github-safe`.
4. If GitHub Desktop says it is not a repository, choose `Create a repository here`.
5. Repository name: `we-met-platform`.
6. Commit summary: `Initial publish-ready We Met platform`.
7. Click `Commit to main`.
8. Click `Publish repository`.
9. Keep `Keep this code private` checked.
10. Click `Publish Repository`.

Before publishing, make sure GitHub Desktop does not list:

```text
backend/.env
backend/node_modules
```

They should not appear.

---

# PART C — deploy with the included Render Blueprint

## 8. Create the Render Blueprint

1. Sign in to Render using GitHub.
2. In the Render dashboard, click `New → Blueprint`.
3. Connect the private `we-met-platform` repository.
4. Keep the Blueprint path as:

```text
render.yaml
```

5. Choose the `main` branch.

Render reads the prepared build, start, health-check, region and timing settings from `render.yaml`.

## 9. Enter the requested private/configuration values

During the initial Blueprint flow, Render asks for values marked `sync: false`.

### `DATABASE_URL`

Paste the complete new Supabase Session Pooler URI. It must contain the new database password, not `[YOUR-PASSWORD]`.

### `ADMIN_PASSWORD`

Enter the same new admin password used during local setup.

### `DEMO_EMPLOYEE_PASSWORD`

Enter the same new listener password used during local setup.

### Direct-UPI values

Enter `UPI_PAYMENT_PAYEE_NAME` exactly as the receiver appears in the UPI app and set `UPI_PAYMENT_ID` to an eligible working receiving UPI ID. The website cannot bypass a UPI or bank receive limit; replace a limited destination or contact the provider.

These values are private deployment configuration; never commit them to GitHub. Signed-in customers receive the UPI details only inside a server-created, expiring payment intent.

Read `UPI_DIRECT_DEPLOY_NOW.md` before opening payments to customers.

### Razorpay later

After KYC unlocks Live Mode, add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` in Render, configure the webhook, change `PAYMENT_GATEWAY_MODE=razorpay`, and redeploy. Use one complete matching set of Live values.

```text
https://wemet.xyz/api/webhooks/razorpay
```

Read `RAZORPAY_SETUP.md` for webhook events, payment capture and Test-to-Live switching.

### `VAPID_PUBLIC_KEY`

Copy `VAPID_PUBLIC_KEY` from the local `backend/.env` created by
`SETUP_WINDOWS.bat`.

### `VAPID_PRIVATE_KEY`

Copy the matching `VAPID_PRIVATE_KEY` from the same local file. Keep it private
and never add it to frontend code or GitHub. Read `PUSH_NOTIFICATIONS_SETUP.md`
for permission behaviour and testing.

Do not put quotation marks around values in the Render form.

Render generates `JWT_SECRET` itself. You do not need to create or paste it.

## 10. Deploy

Review the service and click:

```text
Deploy Blueprint
```

The first deploy performs these actions:

1. installs exact packages from `backend/package-lock.json`
2. runs the production start command
3. creates/upgrades Supabase tables
4. starts the web server
5. checks `/api/health`

The service starts on a free instance for testing. The configured region is Singapore.

## 11. Check the deployment logs

Open the service in Render and select `Logs`.

Successful startup contains lines similar to:

```text
We Met database initialized successfully.
We Met running at https://your-service.onrender.com
```

If deployment fails:

- `DATABASE_URL is required` → the Render database variable is empty
- `password authentication failed` → the Supabase URI/password is wrong
- `JWT_SECRET must...` → remove a manual bad JWT variable and let Render generate it
- `ADMIN_PASSWORD must...` → enter at least 10 characters
- `UPI_PAYMENT_PAYEE_NAME must...` → enter the exact name shown for the receiving UPI account
- `UPI_PAYMENT_ID must...` → enter a valid working UPI ID such as `name@provider`
- Razorpay configuration errors → either add a complete matching key set or change back to `PAYMENT_GATEWAY_MODE=upi_direct`
- `Database unavailable` → verify the Session Pooler URI and Supabase project status

## 12. Open the live portals

Render gives a URL similar to:

```text
https://we-met-platform.onrender.com
```

Open:

```text
Customer: https://YOUR-SERVICE.onrender.com/
Listener: https://YOUR-SERVICE.onrender.com/employee/
Admin:    https://YOUR-SERVICE.onrender.com/admin/
Health:   https://YOUR-SERVICE.onrender.com/api/health
```

## 13. Test the direct-UPI payment flow

1. Sign in to the customer portal and open **Wallet**.
2. Create a small temporary plan in Admin, then choose it as the customer.
3. Scan the QR or copy the receiving UPI ID, confirm the receiver and exact amount in the payment app, complete one small payment, and submit its real transaction ID/UTR.
4. Confirm the customer status is **pending** and no minutes have been added yet.
5. Sign in to **Admin → Payments** and open the receiving UPI app or bank statement independently.
6. Match the exact amount and complete transaction ID; type the requested last four characters and approve.
7. Confirm the status becomes **approved** and the minutes are added once.
8. Refresh and retry the approval to confirm duplicate wallet credit is impossible, then disable the temporary plan.

## 14. Test password recovery

1. From the customer or listener sign-in page, submit **Forgot password**.
2. Save the recovery key shown by the portal.
3. In **Admin → Password resets**, verify the owner and approve the request.
4. Return to the recovery screen, check status and set a new password.
5. Confirm the old password no longer works and the new password signs in.

## 15. Install each PWA

Open the customer, listener and admin portal over HTTPS. In Chrome/Edge use the install icon in the address bar or **Menu → Install app**. On iPhone/iPad use Safari **Share → Add to Home Screen**. Each portal uses its own name, icon and standalone app shell.

Do not share the admin or listener URLs and passwords publicly.

---

# PART D — public test

## 16. Test on two devices

Listener device:

1. Open the listener portal.
2. Sign in.
3. Allow microphone and notifications.
4. Set status to Online.

Customer device:

1. Create a customer account.
2. Use admin to create a one-use coupon.
3. Redeem it in the customer wallet.
4. Start a call.
5. Accept it on the listener device.
6. Allow microphone access.
7. Test audio, chat, mute, end call and wallet deduction.

Also test:

- listener rejection and automatic retry
- 30-second missed-call timeout
- reconnect previous listener
- one-minute low-balance warning
- zero-balance disconnect
- support ticket and admin reply
- customer/listener reports
- timed suspension
- PWA installation on Android

---

# PART E — important hosting limitations

## 17. Free Render is only for testing

The free service can spin down after inactivity. A sleeping service cannot reliably keep listeners online and can delay new calls while it wakes up. Move to an always-on paid web-service instance before using the platform with real customers.

Keep the service at **one instance**. The current online-listener and active-call runtime is stored in one Node process. Do not enable horizontal scaling until a shared Socket.IO/Redis call-state system is added.

## 18. Add TURN before real launch

STUN alone does not work across every Wi-Fi, mobile carrier or firewall. Obtain a managed TURN service or Coturn server, then add these in Render → Environment:

```text
TURN_URL
TURN_USERNAME
TURN_CREDENTIAL
```

Choose `Save and deploy` after adding them.

Test:

- Wi-Fi to Wi-Fi
- Wi-Fi to mobile data
- mobile data to mobile data
- Android Chrome
- Windows Chrome/Edge
- supported iPhone Safari

---

# PART F — custom domain later

## 19. Buy a domain only after the onrender.com test works

Suggested structure:

```text
yourdomain.com            → customer
employee.yourdomain.com   → listener
admin.yourdomain.com      → admin
api.yourdomain.com        → API
```

This package detects these subdomain names automatically and serves the correct portal at `/`.

## 20. Add domains in Render

In your Render web service:

```text
Settings → Custom Domains → Add Custom Domain
```

Add each domain, configure the DNS records shown by Render at your domain provider, and click Verify. Render handles HTTPS certificates after verification.

## 21. Add production origin values after domains work

In Render → Environment, add:

```text
PUBLIC_URL=https://yourdomain.com
ALLOWED_ORIGINS=https://yourdomain.com,https://employee.yourdomain.com,https://admin.yourdomain.com,https://api.yourdomain.com
```

Select `Save and deploy`.

The frontend `API_BASE_URL` values should remain blank when all four domains point to the same Render service. Each portal then uses the API on its own secure hostname.

---

# PART G — before real users

Do not call this a finished production service until you have completed:

- paid always-on hosting
- reliable TURN relay
- Supabase backups
- server and error monitoring
- listener identity and employment verification
- legal review of Terms, Privacy and Safety policies
- age and consent process
- incident response and support process
- abuse/moderation training
- security review and penetration testing
- real multi-network call testing

Voice audio is not recorded by this package. Admin call records contain metadata such as participants, times, duration, billed seconds and end reason—not the audio conversation.
