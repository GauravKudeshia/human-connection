# Human Connection

Human Connection offers three short hosted experiences: **Make Me Laugh**, **Hear Me Out** and **Distract Me**. This repository contains a public browser simulator and a separate, server-authorized staging marketplace. The development branch is `feature/research-driven-beta-foundation`; no live marketplace deployment has been made.

[Open the public interactive demo](https://gauravkudeshia.github.io/human-connection/). It uses fictional hosts, simulated payments and simulated rooms. It needs no account or payment card. Its role previews never grant access to the staging database.

Read the [Master Prompt compliance record](docs/MASTER-PROMPT-COMPLIANCE.md) for current capability status and the [QA evidence](docs/QA-AND-TEST-EVIDENCE.md) for the limits of verification. Older V1.3 and November 14 records are historical snapshots.

## Run and test locally

Use Node **22.14+** and npm. Install with `npm ci`. Run:

```sh
npm test
npm run lint
node node_modules/typescript/bin/tsc --noEmit
npm run build
npm run build:pages
```

`npm run preview:pages` serves the standalone demo at `http://127.0.0.1:4195`. `docs/index.html` also opens directly in a current browser. `npm run dev -- --host 127.0.0.1 --port 4212` serves the existing Worker application. `/beta` opens the connected staging interface and explains when account configuration is unavailable.

The automated tests use transactional SQLite behind the D1 statement interface, local identity fixtures and injected provider responses. They exercise real application services and HTTP Request/Response routing. They do not contact provider accounts or establish actual calls.

## Configure the separate marketplace

1. Copy `.env.example` to ignored `.dev.vars`. Keep credentials out of source control, browser code and chat.
2. Run `npm run db:marketplace:local`. It applies all **eight** migrations in [the canonical order](db/marketplace-migrations.mjs), using only the local `MARKETPLACE_DB` in `wrangler.staging.example.jsonc`. This script rejects arguments and never uses `--remote`.
3. Run `npm run build`, then `npm run start:marketplace:local`. The example configuration uses isolated marketplace database/media bindings and defaults the marketplace to disabled. Preserve the original demo `DB` binding in its existing configuration.
4. Configure a managed OIDC tenant: issuer, access-token audience, JWKS URL, client ID/secret, and the exact application origin. Register `/api/marketplace/auth/callback`. Configure hosted sign-up, verified email, account recovery and staff MFA. Create a server-only random 32-byte session secret in the documented base64 format.
5. Set `HC_MARKETPLACE_ENABLED=true` and `MARKETPLACE_MODE=staging` only in the isolated local/staging configuration. `/beta` then uses hosted OIDC/PKCE and encrypted, revocable HttpOnly sessions. Verified Bearer tokens are also accepted. Browser-supplied identity headers are ignored.
6. Bootstrap staff roles through a trusted database operator. Customers cannot assign roles. Host acceptance requires server-owned approval, verification, certification, current heartbeat and an available global claim. Staff decisions require assigned permissions and recent MFA.
7. For an authorized Stripe test account, configure the three `STRIPE_SANDBOX_*` values and `/api/marketplace/stripe-webhook`. The browser receives only a test publishable key and owned checkout secret. Live keys/responses are rejected. Reconcile actual sandbox captures, partial/full refunds, tips, fees and disputes before any pilot.
8. For an authorized Daily test account, configure its key, webhook secret and `DAILY_ALLOW_TEST_ROOMS=true`. Register `/api/marketplace/daily-webhook`. Verify two independent authenticated browsers, device permissions, network loss and reconnection. Trusted signed provider attendance determines delivery; frontend callbacks do not award earnings.
9. Configure the private `MARKETPLACE_MEDIA` R2 binding for authenticated introduction clips and reviewed profile photos. No public bucket or identity document upload is used.
10. Configure the example minute cron and an authorized sandbox notification destination to exercise leased outbox delivery, alerts, expiry, financial retries and reviewed privacy processing. Notification delivery remains unconfigured by default.

Actual identity/payment/video account verification and hosted deployment have **not** been performed. The user selected local verification for this iteration.

## Financial and privacy controls

Base and tip refunds support monotonic cumulative amounts and immutable compensation. Full or partial base awards require finance review. Test connected-account transfers require a separate disabled-by-default `MARKETPLACE_ALLOW_TEST_TRANSFERS` gate, settled journal balances and a different finance approver. These transfers are not bank payouts. Production merchant structure and bank payout dispatch remain approval-dependent work.

Account closure immediately revokes access and availability. Scheduled private-data erasure requires an explicitly reviewed retention policy and every duration in `.env.example`; destructive processing defaults off. Legal/safety/financial holds preserve required evidence. [Privacy operations](docs/PRIVACY-RETENTION-OPERATIONS.md) describes receipts, holds, retries and the limits of R2/database coordination. External provider account deletion remains a separate operation.

Optional anonymous visit analytics are off by default, use a 24-hour HttpOnly opaque token, retain visit records for 31 days and never link the token to an account. Selection conversion covers consenting visits only. Other analytics derive from actual application events/journal entries and display denominators and cohort maturity.

## Existing prototype HTTP regression

The original full-stack simulator remains separately testable. Apply `drizzle/0000_faulty_clea.sql` to a disposable local demo `DB`, start the existing development server, then run `TEST_BASE_URL=http://127.0.0.1:4212 npm run test:http`. This suite resets its fictional workspace; run it only against disposable local data. It is separate from the normalized marketplace HTTP journey tests included in `npm test`.

## Staging and public publishing

GitHub Pages serves `docs/index.html` and cannot execute authentication, database, payment or video routes. `npm run build:pages` rebuilds the static demo. The updated marketplace source is on the development branch; it is not a publicly deployed application.

A hosted staging environment needs a reviewed copy of the example configuration, isolated D1/R2, server secrets, restricted access, migrations, callback destinations and a restore drill. No staging resources are provisioned by local scripts. Production deployment, live charges, stranger calls, real payouts and customer communications require explicit authorization under the project brief.

## Engineering records

- [Current gap audit](docs/RESEARCH-IMPLEMENTATION-GAP-AUDIT.md) and [Master Prompt compliance](docs/MASTER-PROMPT-COMPLIANCE.md)
- [Architecture](docs/PRODUCTION-ARCHITECTURE.md), [roadmap](docs/IMPLEMENTATION-ROADMAP.md), [readiness](docs/PRODUCTION-READINESS-CHECKLIST.md)
- [Security](docs/SECURITY-THREAT-MODEL.md), [provider decisions](docs/PROVIDER-INTEGRATION-DECISIONS.md), [operations](docs/BETA-OPERATIONS-RUNBOOK.md)
- [QA evidence](docs/QA-AND-TEST-EVIDENCE.md) and [asset credits](ASSETS.md)

Preserve the cream, forest-green and terracotta identity, the three experience choices and the existing demo regression coverage. No social feed, random stranger chat, AI host, clinical treatment, default recording or invented real-host performance is introduced.
