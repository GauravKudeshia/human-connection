# QA and test evidence

## Guest recovery, safety and accessibility follow-up

November 24, 2026. **266 tests passed** without failures or skips in the configured suite. ESLint, TypeScript and the Vinext build passed. The two additive migrations were tested against the prior thirteen-migration schema and through the full local SQLite suite.

- Guest integration tests verified recovery after an interrupted response, scope separation, one-time admission, a report after departure, deadline expiry, staff MFA, an audited takeover, pagination, deduplicated alerts, and retention holds. Account closure immediately revokes access and defers erasure while a guest report may be submitted or remains open.
- A keyboard-driven browser fixture retried an interrupted invitation, observed simulated admission, left the preview and submitted a report. The final screen fit 320, 390, 768 and 1440 px without horizontal overflow. Fixture responses do not use a hosted media connection.
- Media fixtures verified review and access for WebVTT tracks, transcript fallbacks, caption removal on erasure, private two-person room policy and isolation of guest activity from paid delivery. Native playback on physical devices and screen-reader acceptance remain open.

Production and hosted test credentials were unavailable in this workspace. [Three-person Daily rehearsal](DAILY-GUEST-MEDIA-REHEARSAL.md) · [Latest V3 audit](CURRENT-APPLICATION-AUDIT.md#latest-verification-for-guest-recovery-safety-and-accessibility)

## Full V3 audit follow-up

The November 24 follow-up and second audit passed **256 tests, with zero failures or skips**, in the normal engine, browser transport, V1.3, experience and marketplace command. ESLint, TypeScript, Vinext and the GitHub Pages demo build passed. A SQLite database with an existing host profile upgraded from 10 to 13 migrations and replayed the three additions successfully. Integrity and foreign-key checks passed.

- Scheduling tests cover timezone gaps and repeated hours, competing future and immediate reservations, expiry, ownership, unchanged quotes, and rejection before payment when a quote changes. The local HTTP fixture completed a scheduled booking through signed test payment and room attendance callbacks to a $10 receipt.
- Discovery and profile tests cover scoped future profiles, blocked and wrong-language denial, public fields, revision conflicts, introduction access, and the selected host in booking details. A focused browser fixture used the real React components with fictional API results. It exercised topic search, keyboard profile navigation, future-only controls and the scheduled list. My Sessions fit 320, 390, 768 and 1440 px. Surprise Me selected a compatible older style while showing three options. A separate regression proves low comfort overrides a positive quality score.
- Guest tests cover the staging flag, independent claim/status/report/leave quotas, retry-safe links and reports, dual approval, terminal credential removal, unchanged billing, staff MFA, assignment and report holds. Guest preview stops at simulated admission.

Hosted identity and provider verification, physical devices, a full screen-reader pass, and real three-person media remain open. The reproduction uses installed dependencies and local SQLite-backed D1 fixtures. [Current implementation tracker](MASTER-IMPLEMENTATION-TRACKER.md#follow-up-to-the-full-v3-audit)

## V3 review verification

The Nov. 24 baseline had 211 passing tests. The combined V3 implementation passed 232 tests in the configured engine, browser transport, V1.3, experience and marketplace suites. ESLint, TypeScript and both application builds passed. The local SQLite migration test upgraded an eight-migration database with an existing account and applied both additive migrations twice, with no integrity or foreign-key failures.

New coverage includes the restored laughter booking at its original price, language eligibility and offline supply, multi-factor workspace entry and fixed callback destinations, paying-customer review ownership and moderation paging, removal of written review data on account closure, both guest consent gates, link expiry and replay, parallel claims and admissions, and participation with the original timer and price. Host application steps and guest screen states were exercised in component harnesses.

The installed Node dependency tree was used. The npm executable was unavailable for a fresh `npm ci` in this environment. Chrome timed out launching, so the requested viewport and physical device walkthrough remains open. Managed sign-in, cross-device guest link behavior, provider callbacks, actual sharing-client behavior, and footage or media from live participants were outside the local test boundary.

November 15, 2026 · development branch `feature/research-driven-beta-foundation`.

## Baseline and current automated checks

The original audit baseline had 58 passing tests. The previous continuation had 130. The current suite has **195 passing tests, zero failures/skips**. The original regressions remain. `npm run lint`, TypeScript (`node node_modules/typescript/bin/tsc --noEmit`), `npm run build` and `npm run build:pages` pass. The Worker retains its existing informational route-classification notice. The original disposable prototype HTTP integration suite also passed separately (1 test). The current dependency advisory scan reports zero known vulnerabilities. No dependency was added in this continuation.

`npm run db:marketplace:local` applies all eight canonical migrations successfully through local Wrangler D1. The migration list is shared with the test adapter. A quiesced SQLite restore verifies integrity, foreign keys, roles, ownership and active-claim uniqueness. Hosted D1 timing/load/restore remains untested.

## Meaningful test boundaries

| Sources under `tests/`                                 | Verified local behavior                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original engine/browser transport/V1.3/evolution tests | Existing demo journeys, preferences, recovery, receipts, value separation, activities and demo/live boundaries                                                                                                                                                                                                                           |
| Marketplace auth/browser-auth/beta-api                 | JOSE claims, local OIDC/PKCE exchange, nonce/state, cookie revocation, MFA, unauthorized/stale client results and retries                                                                                                                                                                                                                |
| Marketplace store/experience                           | Eligibility/certification/heartbeat/blocks, atomic global claims, expiry, role/object access, shared revisions, favorites/replacement, drafts, genuine-statistic denominators and reviewed photos                                                                                                                                        |
| Marketplace finance/payouts                            | Quotes, integer boundaries, signature/replay/order, capture/refund compensation, partial/full base and tip totals, fees/disputes, immutable awards, transfer holds/maker-checker/stable retry/reversal                                                                                                                                   |
| Marketplace sessions                                   | Paid/private participant grants, both active accounts, closing during token request, signed attendance, reconnect/overlap, independent ending, no-room/no-join failure and cleanup                                                                                                                                                       |
| Marketplace operations/analytics                       | Bounded outbox retry/leases, no alert loops, scope/privacy, UTC metrics, mature repeat cohorts, latency, utilization interval unions and opt-in unlinked visitor expiry/coverage                                                                                                                                                         |
| Marketplace privacy                                    | Disabled destructive default, reviewed immutable retention snapshot, immediate closure/revocation, concurrent capture retry, identity reprovision race, holds/leases, cleanup retry and preserved financial/policy/audit evidence                                                                                                        |
| Marketplace boundaries/HTTP handlers                   | Origin/JSON/quota/log privacy, scoped account suspension, draft race, refund review reopening, receipts and optional visitor-cookie revocation                                                                                                                                                                                           |
| Marketplace journeys                                   | Actual HTTP Request/Response router through all three experiences, host accept, local signed fixture payment, private token, trusted overlap, shared activity, feedback/favorite/rebook; HTTP contention, decline/expiry, paid-no-join with/without room, report/block, privacy/forged headers and repeated/out-of-order signed fixtures |

These use actual SQLite transactions and application services. Provider responses and identities are explicit local fixtures. Passing them does **not** establish an operating managed tenant, actual Stripe checkout or a real Daily call.

## Browser verification

One browser engine checked customer, host and staff views at **320, 390, 768 and 1440** pixels, with no horizontal overflow. The standalone UI harness is visibly labeled **LOCAL UI TEST FIXTURE — Fictional accounts and records**. It adapts Next link/image components and injects fictional API responses; it is not a deployment or provider end-to-end test.

The continuation verified host quality counts and photo/intro controls, account-closure disclosures and disabled-by-default action, partial-refund input/required explanation, disabled sandbox-transfer state, mature repeat/latency/utilization displays, UTC dates and keyboard focus/navigation. No warning/error logs were observed in the fixture during the final checks. The actual Worker `/beta` was checked separately and clearly showed the unconfigured account state and laughing imagery, with no browser error logs. A screenshot is saved in workspace outputs as `human-connection-master-audit-preview.png`.

The previous browser pass completed each public simulated experience journey. The new automated router journeys add server integration evidence. Neither substitutes for two actual provider-connected browsers. Comprehensive physical-device, independent-engine, specialist screen-reader and in-call accessibility remain unverified.

## Independent second-pass findings resolved

Review found and fixed cumulative-refund rounding at supported large amounts; remaining-principal review reopening and replay; paid bookings never expiring if no room was requested; capture racing account closure; closed customer racing host token grants; erased identity reprovisioning; private-draft/upload resurrection; and recursive alert-delivery failure chains. Each material path has targeted local regression coverage. R2/database erasure atomicity remains an explicitly documented infrastructure limit.

## External evidence still required

Actual managed account creation/recovery/MFA/JWKS rotation; Stripe sandbox SDK checkout/refund/dispute/transfer account evidence; Daily two-browser devices/network recovery; actual notification/alert receipt; hosted concurrency/load/restore; physical-device, independent-engine, specialist accessibility and infrastructure penetration review. The user selected local verification, so none of these are recorded as passed.

Production launch, real money, stranger calls, bank payouts, provider account erasure, policy approval and staffed service remain outside the executed evidence. See [compliance](MASTER-PROMPT-COMPLIANCE.md) and [readiness](PRODUCTION-READINESS-CHECKLIST.md).
