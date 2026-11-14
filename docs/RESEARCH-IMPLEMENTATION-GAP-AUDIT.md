# Research implementation gap audit

November 14, 2026. Baseline source matches the published audit-fix tree at `7826ebf7fd5f84480d2d1951674848389d955b42`. Development continues on `feature/research-driven-beta-foundation`.

## Baseline evidence

The existing application has two working simulation transports. GitHub Pages bundles the shared React interface and engine into one static HTML file. The optional Worker persists an owner-scoped JSON workspace with optimistic locking. Its identity comes from the Sites proxy. Hosts and role previews remain fictional in both transports.

The baseline ran before feature changes. All 58 domain and browser-transport tests passed. ESLint, TypeScript, the Pages build and the Worker build passed. The Worker build retained Vinext's informational notice that static analysis cannot classify the root route. The generated public file was about 1,400 KiB.

| Feature | Existing implementation | Evidence | Status | Risk | Research recommendation | Implementation action | Verification | Priority |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Experience selection | Three experiences, optional style, time, format and language | `moment-finder.jsx`, `catalog.mjs`, `v13.test.mjs` | Implemented in demo | Low | Lead with a bounded hosted activity | Preserve journey and add visible price context | Three independent experience journeys | P1 |
| Profile discovery | Fictional photos, written intros, search and filters | `profile-dialog.jsx`, `host-browser.jsx` | Simulated | Medium | Show earned expertise and genuine introduction media | Preserve honest labels and design real-host records | No fabricated badges or review totals | P1 |
| Value feedback | Delivered-only rating and private failure feedback | `engine.mjs`, `session-flow.jsx` | Partial | Medium | Measure value separately from a host rating | Add worth-it response and private quality feedback | Eligible denominator, skip handling and retry tests | P1 |
| Rebooking | History reopens a host with prior preferences | `session-history.jsx`, `receipt-panel.jsx` | Implemented in demo | Low | Make a repeat experience easy to start | Preserve host rebooking and add repeat-experience entry | Preference preservation and fresh reservation | P1 |
| Authentication | Sites proxy identity headers and local mock sign-in | `chatgpt-auth.ts`, `store.ts` | Partial | Critical | Use independently verified identities | Add a separate signed-token staging boundary | Reject unconfigured or invalid issuer, audience and expiry | P0 |
| Role and object authorization | Every owner controls all fictional roles | `connection-app.jsx`, `operations.jsx` | Simulated | Critical | Separate staff duties and record ownership | Persist server-assigned roles and enforce participant access | Customer, host, safety and finance negative tests | P0 |
| Persistent relational data | One JSON record per owner | `db/schema.ts`, `store.ts` | Partial | High | Keep owners, claims and events independently constrained | Add an isolated normalized staging schema | Repeatable migration and relational constraint tests | P0 |
| Global matching and reservations | Deterministic matching within one workspace | `matching.mjs`, `engine.mjs` | Simulated | Critical | Check approval, heartbeat, blocks and global conflict | Enforce global claims in the database | Concurrent customers produce one conflicting claim | P0 |
| Booking expiry | Access-time expiry and three-minute accepted/join deadlines | `engine.mjs`, `v13.test.mjs` | Implemented in demo | High | Expire authoritative records while clients are absent | Add server expiry and a reconciliation entry point | Expiry boundary and durable release tests | P0 |
| Host onboarding | Application and training decision in role preview | `host-studio.jsx`, `engine.mjs` | Simulated | High | Separate identity, experience approval and public profile | Add persisted application and certification states | Unapproved host cannot become eligible | P0 |
| Identity verification | Adult acknowledgement | `booking-options.jsx` | Missing external verification | Critical | Store a verification reference with a distinct suitability review | Require verified records for staging eligibility | Incomplete identity and expired certification rejected | P0 |
| Introduction uploads | Written sample only | `profile-dialog.jsx` | Missing | High | Publish consented, reviewed clips with accessible alternatives | Keep upload work explicitly pending | Authenticated bounded upload and moderation tests needed | P1 |
| Authoritative quotes | Integer-cent fixed demo prices | `demo-policy.mjs`, `engine.mjs` | Simulated | High | Version bounded price terms and ignore client amounts | Add reusable server quote policy | Quote expiry, policy version and integer arithmetic | P0 |
| Payments and callbacks | Fictional checkout, no provider | `engine.mjs`, `demo-policy.mjs` | Missing external integration | Critical | Use sandbox provider requests and authenticated callbacks | Add provider boundary and fail-closed configuration | Signature, replay, ordering and amount checks | P0 |
| Journal and receipts | Balanced fictional groups and compensating refunds | `engine.mjs`, `receipts.mjs` | Implemented in demo | High | Keep financial events immutable and reconcile provider records | Add isolated financial policy and event handling | Duplicate payment/refund/tip and balancing tests | P0 |
| Payouts | No money transfers or bank information | `demo-policy.mjs` | Missing | Critical | Resolve the merchant model and provider eligibility first | Keep payouts disabled | Operator and provider approvals remain required | P0 |
| Private media | Explicit room simulation | `session-flow.jsx` | Missing external integration | Critical | Create participant-bound private rooms and short-lived tokens | Add server-only provider boundary | Room binding, expiry and provider failure tests | P0 |
| Shared activities | Compatible local card selection | `activities.mjs`, `activity-panel.jsx` | Simulated | Medium | Synchronize a small activity state between participants | Add card progression in demo and authorized staging revision updates | Two actors read one revision and reject stale updates | P1 |
| Safety and blocks | Local reports, cases, blocks and closure protection | `engine.mjs`, `operations.jsx` | Simulated | Critical | Restrict case access and independently record reports | Add persisted reports and role checks | Nonstaff cannot read or resolve a case | P0 |
| Notifications | Activity history and toast feedback | `connection-app.jsx`, `app-modal.jsx` | Partial | High | Persist retryable deliveries and alert operators | Record the pending provider and worker work | Delivery retry and failure escalation needed | P0 |
| Analytics | No genuine acquisition or commercial metrics | `operations.jsx` | Missing | Medium | Use real events, ranges and denominators | Add bounded value feedback aggregation without invented activity | Empty and partial samples show counts | P1 |
| Deployment and backups | Static Pages and optional local Worker | `pages/build.mjs`, `vite.config.ts` | Partial | High | Keep staging isolated and exercise restoration | Document migrations, backup and staged rollout | Build, migration and restoration evidence | P0 |

## Competitive patterns reviewed

These are observations of official pages accessed on November 14. Statements about quality, safety effectiveness or business performance remain unverified. Product conclusions below are engineering inferences from the visible positioning.

| Reference | Observable pattern | Human Connection action |
| --- | --- | --- |
| Rent A Cyber Friend | A directory and instant pay-per-minute conversation proposition | Keep a transparent total and accepted host before checkout. [Official site](https://www.rentacyberfriend.com/) |
| E-Pal | Search by shared activity or interest, then confirm a service with a host | Make the activity and host suitability clear before reserving. [Official site](https://www.epal.gg/) |
| 7 Cups | Free listener support is presented alongside a separate therapy offering | Retain a defined non-clinical experience and measurable service value. [Official site](https://www.7cups.com/) |
| HearMe | Trained-listener positioning and matching precede the conversation | Require explicit host experience approval before eligibility. [Official site](https://hearme.app/) |
| Bobi | A short-conversation proposition and waitlist are visible | Treat its delivery claims as unverified. Differentiate through accountable execution and interactive entertainment. [Official site](https://gobobi.app/) |
| Chatroulette, OmeTV and Emerald Chat | Fast random or interest-based contact with visible moderation claims | Preserve intentional host choice, bounded delivery and independent leave, block and report controls. [Chatroulette](https://chatroulette.com/), [OmeTV](https://ome.tv/), [Emerald Chat](https://emeraldchat.com/) |
| RentAFriend | Official page returned HTTP 403 during this research pass | No new claim about its current implementation is used. [Official site](https://rentafriend.com/) |

Make Me Laugh has the clearest authored activity catalog in the existing product. Experience approval, optional improvisation prompts and the worth-it question make that direction testable without introducing an open social feed.

## Reading the branch results

The baseline matrix above records what existed before this work. [Architecture](PRODUCTION-ARCHITECTURE.md), [roadmap](IMPLEMENTATION-ROADMAP.md), [test evidence](QA-AND-TEST-EVIDENCE.md) and [readiness checklist](PRODUCTION-READINESS-CHECKLIST.md) record the implementation outcome and remaining dependencies.

