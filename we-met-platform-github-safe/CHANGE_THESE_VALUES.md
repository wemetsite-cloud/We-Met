# Values you must enter manually

Most normal business values are already configured. Never send these private values in chat.

## Local setup

`SETUP_WINDOWS.bat` asks for:

1. New Supabase Session Pooler URI
2. New admin password
3. New listener password

It generates `JWT_SECRET` automatically.

## Render Blueprint

Render asks for:

```text
DATABASE_URL
ADMIN_PASSWORD
DEMO_EMPLOYEE_PASSWORD
```

Use the same new values used during local setup.

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
Payment mode: coupons/manual credit only
```
