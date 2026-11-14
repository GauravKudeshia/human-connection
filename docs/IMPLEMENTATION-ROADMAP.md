# Implementation roadmap

November 14, 2026. Work follows the existing repository and its three experience model. Development stays on `feature/research-driven-beta-foundation`.

## Branch scope

| Capability | Branch disposition | Evidence |
| --- | --- | --- |
| Existing experience journey, matching, refunds and receipts | Preserved demo behavior | Original 58 regression tests and shared engine |
| Worth-it question and private quality feedback | IMPLEMENTED AND TESTED in the demo | `lib/engine.mjs`, `tests/evolution-experience.test.mjs` |
| Value counts with sample sizes and date range | IMPLEMENTED AND TESTED in the demo | `valueFeedbackSummary`, Operations overview and feedback tests |
| Three-round optional activities | IMPLEMENTED AND TESTED in the demo | `lib/activities.mjs`, activity revision tests |
| Server quote and allocation policy | Implemented local foundation | `lib/marketplace/pricing.mjs`, finance tests |
| Signed identity, persisted roles and owned resources | Isolated staging foundation | `lib/marketplace/auth.mjs`, marketplace store and tests |
| Normalized state, global claims and expiry | Isolated staging foundation | `db/marketplace.sql`, marketplace store and SQLite integration tests |
| Host application, verification reference and experience certification | Isolated staging foundation | Marketplace host actions and eligibility queries |
| Persisted report, block and restricted review actions | Isolated staging foundation | Marketplace safety and finance permissions |
| Shared activity revisions | Isolated staging foundation | Participant-authorized activity state and revision checks |
| Stripe sandbox adapter and signed callback handling | IMPLEMENTED BUT NOT CONFIGURED | Provider and finance modules, injected-response tests |
| Daily private-room/token adapter | IMPLEMENTED BUT NOT CONFIGURED | Provider module and request-contract tests |
| Real identity-verification provider | NOT STARTED | Provider selection and deployment work required |
| Host intro upload, consent and moderation | NOT STARTED | No upload endpoint or approved media supply |
| Customer adult/U.S. eligibility and policy-acceptance history | NOT STARTED for marketplace actors | Existing acknowledgements belong to the demo |
| Full live session delivery and overlap evidence | NOT STARTED | Needs media client, provider events and two-browser verification |
| Provider fees, disputes, transfers and payouts | NOT STARTED / REQUIRES APPROVAL | Merchant model, policies and provider integrations required |
| Managed sign-up, recovery, logout and MFA enrollment | IMPLEMENTED BUT NOT CONFIGURED at the verifier boundary | Real identity tenant and client flow remain required |
| Background scheduling and notification delivery | Partial persistent records | No configured delivery provider or continuously running reconciliation worker |
| Live operation | REQUIRES APPROVAL | See readiness checklist |

“Foundation” identifies code that can be exercised locally. The [QA record](QA-AND-TEST-EVIDENCE.md) specifies which boundaries were actually tested.

## Next dependency sequence

1. Configure an isolated staging deployment and identity tenant. Exercise the HTTP routes with independent customer, host, reviewer, safety and finance accounts.
2. Review and provision host eligibility evidence. Integrate secure introductions and the chosen identity provider before adding genuine host supply.
3. Configure Stripe sandbox checkout and signed callback delivery. Reconcile capture, refund and exceptions against the provider account.
4. Connect the customer/host frontend to the staging routes. Integrate private media and establish delivery with participant presence.
5. Configure scheduled expiry/reconciliation and durable notification delivery. Exercise staff alert receipt and incident ownership.
6. Complete retention, backup restoration, operational monitoring and specialist accessibility verification.
7. Seek the stated approvals and explicit authorization for a controlled live pilot.

## External dependencies

| Dependency | What it blocks |
| --- | --- |
| Identity tenant and client configuration | Real sign-in, recovery, sign-out and staff MFA exercise |
| Independent D1 staging binding and authorized deployment | Hosted multi-user verification and operational restore drill |
| Payment test account and webhook endpoint | Actual sandbox end-to-end checkout and refund evidence |
| Processor service approval and merchant model | Any live payment, transfer or payout activation |
| Authorized video test account | Two-browser private room, device and network delivery tests |
| Verification vendor and reviewed host process | Genuine host eligibility and identity claims |
| Staff coverage and reviewed incident guidance | Any promised live safety response |
| Approved privacy, refund and retention policies | Production operations and deletion behavior |

## Later experiments

Gift sessions, referral credits, premium host pricing, membership, additional languages and geographic expansion remain backlog items. Evaluate them after reliable delivery and genuine value feedback exist.

The three primary experiences, optional activities and respectful non-clinical boundaries remain the product focus. No social feed, unsolicited stranger messaging or default recording is introduced.

