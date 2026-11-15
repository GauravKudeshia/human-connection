# Human Connection

The [continued implementation record](docs/CONTINUED-IMPLEMENTATION-2026-11-14.md) describes the connected beta interface, hosted sign-in flow, media attendance, host introductions, appeals, notifications and sandbox reconciliation added after the foundation review. Open `/beta` on the local Worker to use that interface. Node 22.14 or newer is required by the media SDK.

Apply `db/marketplace.sql`, then `db/marketplace-auth.sql`, `db/marketplace-session-finance.sql` and `db/marketplace-operations.sql` to an isolated staging database. The [staging configuration example](wrangler.staging.example.jsonc) supplies the binding names. Copy and fill it for local testing, run `npx wrangler dev --local --port 4212 --config wrangler.staging.example.jsonc` after building, and register `/api/marketplace/auth/callback` as the managed provider's callback. Server-only credentials belong in ignored `.dev.vars` or the staging secret store. Keep the application origin aligned with the local port.

## Research-driven development branch

The work on `feature/research-driven-beta-foundation` adds a separate staging API, normalized database schema, role and ownership checks, shared host reservations and activities, sandbox payment boundaries and private value feedback. The public Pages entry continues to use the browser simulator.

Read the [implementation gap audit](docs/RESEARCH-IMPLEMENTATION-GAP-AUDIT.md), [architecture](docs/PRODUCTION-ARCHITECTURE.md), [roadmap](docs/IMPLEMENTATION-ROADMAP.md), [readiness checklist](docs/PRODUCTION-READINESS-CHECKLIST.md), [provider decisions](docs/PROVIDER-INTEGRATION-DECISIONS.md), [threat model](docs/SECURITY-THREAT-MODEL.md), [operations runbook](docs/BETA-OPERATIONS-RUNBOOK.md) and [test evidence](docs/QA-AND-TEST-EVIDENCE.md). The V1.3 handoff documents describe the earlier release.

### Local development and tests

Use Node 22.14 or newer. Run `npm ci`, `npm test`, `npm run lint` and `node node_modules/typescript/bin/tsc --noEmit`. The new integration tests use Node's SQLite module with a D1-compatible transactional adapter. `npm run build:pages` builds the standalone demo and `npm run preview:pages` serves it locally.

The existing `npm run build` and `npm run dev -- --port 4193 --hostname 127.0.0.1` commands build and serve the Worker prototype. Run `TEST_BASE_URL=http://127.0.0.1:4193 npm run test:http` only against a disposable prototype workspace.

### Configure isolated staging

1. Provision a separate D1 database and bind it as `MARKETPLACE_DB` in an isolated staging Worker configuration. Apply `db/marketplace.sql` there. Preserve the existing demo `DB` binding.
2. Copy `.env.example` to ignored local `.dev.vars`. Keep staging deployment secrets in the provider's secret store. Set the OIDC issuer, API audience and HTTPS JWKS URL for a managed identity tenant. The API expects signed RS256 access tokens with verified-email claims.
3. Use hosted provider login and recovery with those access tokens. The new marketplace API accepts Bearer tokens. The customer demo UI still uses its simulator transport and has no production account flow.
4. Bootstrap staff roles through a trusted database operator. Customer, host, host reviewer, safety and finance roles are stored in the database. Sensitive staff operations require recent provider-asserted MFA.
5. After storage and identity configuration, set `HC_MARKETPLACE_ENABLED=true` and `MARKETPLACE_MODE=staging`. Request `/api/marketplace?resource=me` with a verified access token to confirm the boundary. POST actions require same-origin JSON and an idempotency key.
6. To test payment intents, configure server-only `STRIPE_SANDBOX_SECRET_KEY` and `STRIPE_SANDBOX_WEBHOOK_SECRET`. Configure the raw-body callback endpoint `/api/marketplace/stripe-webhook` in an approved Stripe test account. Live keys are rejected.
7. The Daily adapter needs an explicitly authorized test account and still requires paid-room entitlement, media-client and presence integration before browser calls can be exercised.
8. Configure a staging cron to invoke the Worker's scheduled handler for expiry reconciliation. In-app notifications persist in an outbox. External delivery and alert routing require further integration.
9. Review the staging manifest and access restrictions before deploying it through the selected hosting service. This branch has no configured staging identity, database binding, provider accounts or deployment target. The readiness checklist records the remaining launch work.

No provider credentials, identity documents or conversation contents belong in the static build. Application tests use fictional identities and injected provider responses. Processor approval, host verification, safety staffing, approved policies and authorized launch remain prerequisites for real sessions and money.


**[Open the interactive demo](https://gauravkudeshia.github.io/human-connection/)**

Choose **Make Me Laugh**, **Hear Me Out**, or **Distract Me** and meet a fictional host for a simulated 15- or 30-minute session. Anyone with the demo link can try it without an account, installation, or payment card.

The homepage opens with three selectable photo scenes. You can also try a sample conversation starter and take its style into demo matching. [Homepage design audit](docs/HOMEPAGE-DESIGN-AUDIT.md)

## V1.3: find your moment

1. Choose an experience and an optional conversation style.
2. Choose 15 or 30 minutes, audio/video and language. Use **Match Me Now** or browse hosts yourself.
3. Simulate the host’s acceptance, review the exact demo total, and confirm checkout.
4. Join within three minutes or receive a full automatic demo reversal. Explore optional sample activity cards inside the simulated room.
5. Complete the demo to try a review and optional tip; use receipts, refund review, favorites and rebooking. Host studio and Operations remain fictional role previews.

See [feature audit](docs/V1.3-FEATURE-AUDIT.md), [product experience](docs/V1.3-PRODUCT-EXPERIENCE.md), [engineering changes and tests](docs/V1.3-ENGINEERING-CHANGES.md), and [production gaps](docs/V1.3-PRODUCTION-GAPS.md).

The [November 12 audit fixes](docs/AUDIT-FIXES-2026-11-12.md) cover booking preferences, review completion, decision history, authentication expiry, reset retries, storage recovery and updated dependencies.

The public preview runs entirely in your browser. Activity survives reloading the same tab when session storage is available. It does not sync to another device or another visitor. Use fictional details only. Reports do not notify a real person; no payments, microphone capture, camera access or live calls occur in the public demo.

You can also download `docs/index.html` and open it directly in a current browser. The interface, portraits and scripts are embedded; external fonts are optional.

## Source and publishing

- `app/`: shared React interface and the original full-stack server routes.
- `lib/`: fictional host catalog, booking and simulated ledger rules, and server-side D1 storage.
- `pages/`: guest preview transport and static build entry point. GitHub Pages serves `docs/index.html`, not the server routes.
- `tests/`: domain and public-preview tests. The HTTP integration test is for a disposable local full-stack database only.

### Rebuild the public preview

With Node 22.14+ and npm, run `npm ci`, `npm test`, then `npm run build:pages`. Commit the generated `docs/index.html`. In GitHub **Settings → Pages**, publish **main /docs**. The `docs` folder contains the public demo, `.nojekyll`, and the public V1.3 handoff documents. No runtime data or secrets are published.

For a local preview, run `npm run preview:pages` after building and open `http://127.0.0.1:4195/`. Stop it with Ctrl+C. Useful checks are `npm run lint`, `npm test`, and `node node_modules/typescript/bin/tsc --noEmit`.

### Run the full-stack prototype separately

Run `npm ci`, `npm run build`, apply `drizzle/0000_faulty_clea.sql` once to a new local D1 database, then run `npm run dev -- --port 4193 --hostname 127.0.0.1`. Example migration command:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_faulty_clea.sql
```

The HTTP integration suite must run only against a disposable local workspace: `TEST_BASE_URL=http://127.0.0.1:4193 npm run test:http`. It resets that test workspace.

The full-stack preview uses Sites authentication and owner-scoped D1 storage. Its checkout and room are also simulated. This repository contains no original hosting-project identity, customer data, provider keys or local database.

## Scope

Human Connection is an interactive prototype, not a working paid marketplace or a staffed safety service. Real verified hosts, provider integrations, policy approvals, and production operational controls are outside this demo. See [asset credits](ASSETS.md).
