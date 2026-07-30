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

Upgrade to a paid always-on instance and add TURN before opening the service to real customers.
