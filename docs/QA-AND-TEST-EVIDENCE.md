# QA and test evidence

The [continued implementation record](CONTINUED-IMPLEMENTATION-2026-11-14.md) supersedes the foundation status descriptions below for browser authentication, connected beta screens, host media, attendance, financial operations and notifications. Its evidence distinguishes local implementation from unexecuted provider-account verification.

November 14, 2026. Evidence is recorded against the development branch. All fixtures use fictional accounts and activity.

## Baseline

Before changing existing features, the following commands completed successfully.

| Command | Result |
| --- | --- |
| `npm test` | 58 passed, zero failures |
| `npm run lint` | Passed |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed |
| `npm run build:pages` | Passed, approximately 1,400 KiB standalone HTML |
| `npm run build` | Passed with existing informational root-route classification notice |

## New test boundaries

| Test source | Coverage |
| --- | --- |
| `tests/evolution-experience.test.mjs` | Seven passing tests for independent value/private/public feedback, completed-session gates, optional skip, denominators, date bounds, narrative removal, activity revision, replay and storage recreation |
| `tests/marketplace-finance.test.mjs` | Server quote policy, sandbox credentials, stable payment idempotency, captured/refunded financial evidence, event ordering, provider mismatches, signatures and private media request properties |
| Marketplace integration tests | Normalized schema, actor roles, global claims, expiry, host eligibility, blocks, restricted safety/refund actions and shared activity revisions |
| Existing domain/transport tests | Original reservation, payment simulation, ratings, tip, receipt, privacy, closure and retry regressions |

The financial tests use actual SQLite persistence with injected provider responses. That establishes application contract behavior and accounting changes. No provider test-account checkout or real media session is represented as executed.

The normalized service integration harness uses `node:sqlite` behind a D1-compatible statement and atomic batch adapter. Hosted D1 timing, provider delivery and managed-identity behavior require separate staging evidence.

## Browser verification record

Executed browser evidence appears in the final branch verification below. Physical and specialist checks remain independent staging work.

## Final branch verification

- All 87 automated tests passed, including the original 58 regressions, seven experience tests, two signed-identity tests, nine shared-store tests and eleven payment/provider tests.
- The existing HTTP integration suite passed against the disposable local prototype.
- The normalized SQL migration executed successfully with local D1 through Wrangler.
- The unconfigured marketplace HTTP endpoint returned a controlled `MARKETPLACE_DISABLED` error.
- ESLint, TypeScript, static Pages build and Worker build passed. The existing informational route-classification notice remains.
- The full dependency advisory scan reported zero known vulnerabilities.

Browser checks used one engine at 320, 390, 768 and 1440 pixels with no homepage horizontal overflow. All three simulated journeys reached completion. Make Me Laugh verified persisted prompt progression after reload, independent value and private feedback, and repeat preferences. Hear Me Out verified browsing into a compatible host and the bounded listening activity. Distract Me verified trivia answer reveal, favoriting and repeat selection. The preview console recorded no errors or warnings during these journeys.

Independent review found and corrected a payment-success race at reservation expiry, a checkout secret returned after concurrent cancellation, a missing provider-originated refund queue record and allocation rounding at large safe integers. Each financial path has a regression test. The tests use actual SQLite transactions and injected provider responses.

A screenshot of the reviewed homepage is saved beside the workspace outputs as `human-connection-research-preview.png`. The GitHub Pages bundle is built for review on the development branch. The branch adds a scheduled expiry handler, while the staging schedule and provider accounts still require configuration.


Physical-device, specialist screen-reader and independent browser-engine testing are unavailable in the current environment. Those checks remain listed in the readiness checklist.

## Remaining end-to-end exercises

| Scenario | Verification still needed |
| --- | --- |
| Real managed account onboarding and recovery | Configured identity tenant and frontend flow |
| Distinct customer and host in a provider room | Authorized video account and two authenticated browsers |
| Payment succeeds but participants fail to join | Actual provider sandbox callback and presence pipeline |
| Live provider failure and reconnect | Device/network test through integrated media client |
| Provider webhook repeats or arrives out of order | Real sandbox event destination, in addition to local event tests |
| Notification retries and alert receipt | Delivery provider, scheduled worker and operator destination |
| Hosted contention and restore | Isolated staging D1 deployment and verified recovery copy |

Use the root README for current commands and configuration placeholders. [Readiness checklist](PRODUCTION-READINESS-CHECKLIST.md) records the go/no-go criteria.

