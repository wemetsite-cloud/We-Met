# Deployment

The recommended first deployment is one Render web service created from the included `render.yaml` Blueprint.

Read the complete instructions in:

```text
PUBLISH_STEP_BY_STEP.md
```

The Blueprint uses:

```text
Region: Singapore
Plan: Free for initial testing
Instances: 1
Build: cd backend && npm ci --omit=dev
Start: cd backend && npm run start:production
Health check: /api/health
```

The production start script runs the idempotent database initializer and then starts the Node server. Existing seeded passwords are preserved while `RESET_SEEDED_PASSWORDS=false`.

For immediate customer payments, enter the private receiving UPI name and ID requested by the Blueprint and follow `UPI_DIRECT_DEPLOY_NOW.md`. Direct UPI payments require independent administrator verification in the receiving UPI app or bank statement. After Razorpay KYC unlocks Live Mode, follow `RAZORPAY_SETUP.md`, add the three private Razorpay values, configure the signed webhook at `https://wemet.xyz/api/webhooks/razorpay`, and change the payment mode.

Add the matching `VAPID_PUBLIC_KEY` and server-only `VAPID_PRIVATE_KEY` requested
by the Blueprint to enable notification-bar alerts. Follow
`PUSH_NOTIFICATIONS_SETUP.md` and keep the same pair between deployments.

Upgrade to a paid always-on instance and add TURN before opening the service to real customers.
