# Values you must enter manually

Most normal business values are already configured. Never send these private values in chat.

## Local setup

`SETUP_WINDOWS.bat` asks for:

1. New Supabase Session Pooler URI
2. New admin password
3. New listener password
4. Direct UPI or Razorpay mode
5. Direct UPI: exact receiving name and a working eligible UPI ID
6. Razorpay: matching Test/Live Key ID, Key Secret and webhook secret

It generates `JWT_SECRET` automatically.
It also generates a matching VAPID public/private pair for browser notification-bar alerts.

## Render Blueprint

Render asks for:

```text
DATABASE_URL
ADMIN_PASSWORD
DEMO_EMPLOYEE_PASSWORD
UPI_PAYMENT_PAYEE_NAME
UPI_PAYMENT_ID
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use the same new values used during local setup. Copy the VAPID pair from the
local `backend/.env` only into Render; never upload that file.

## Optional after testing

For reliable public calls:

```text
TURN_URL
TURN_USERNAME
TURN_CREDENTIAL
```

After buying a domain:

```text
PUBLIC_URL
ALLOWED_ORIGINS
```

## Already configured

```text
Brand: We Met
Support: wemetsite@gmail.com
Admin display name: Sabith Salah Kp
Admin username: sabithkp
Listener name: Salah
Listener email: gentle8x@gmail.com
Listener code: WM-L001
Call language: Malayalam
Interface language: English
Minimum starting balance: 2 minutes
Ring timeout: 30 seconds
Low-balance warning: 1 minute
Default payment mode: QR + copyable UPI ID with transaction-ID verification
Receiving requirement: an eligible working UPI ID that is not currently limited
Later mode: Razorpay Standard Checkout with Live keys and https://wemet.xyz/api/webhooks/razorpay
Background alerts: standards-based Web Push with private server VAPID key
```
