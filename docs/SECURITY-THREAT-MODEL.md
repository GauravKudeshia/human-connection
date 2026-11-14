# Security threat model

November 14, 2026. Scope includes the existing browser demo, owner-workspace prototype and the branch's isolated staging marketplace boundary.

## Assets and trust boundaries

Private assets include identity-verification references, provider credentials, customer bookings, safety narratives, financial references and staff decisions. Public host display data must remain a deliberate projection of approved fields.

| Boundary | Required invariant |
| --- | --- |
| Static browser demo → local state | Fictional activity confers no authority over marketplace accounts or provider objects |
| Browser → marketplace API | A verified access token identifies the actor. Request payloads cannot assign roles or ownership |
| API → marketplace D1 | Parameterized queries and database constraints preserve owners, claims and state transitions |
| Identity provider → API | Signature, issuer, audience, expiry, token type and required claims are validated |
| Staff actor → sensitive action | Persisted role, active account and recent higher-assurance authentication are checked |
| Payment provider → callback | Raw-body signature and test-mode gates precede any financial mutation |
| Booking → media provider | Authorized participants receive bounded grants for their own booking |
| Application → logs and analytics | Secret values and private conversation/report contents stay outside general telemetry |

## Threats and disposition

| Threat | Implemented boundary or mitigation | Verification and remaining work |
| --- | --- | --- |
| Forged identity headers | Marketplace authentication uses a signed RS256 bearer token and server-selected JWKS. Sites headers remain in the separate prototype. | Auth tests must reject unsigned, wrong-key, expired, wrong-issuer and wrong-audience tokens. Configure real tenant rotation and logout exercises. |
| Client-selected role or object owner | Roles come from persisted assignments and services check the actor on each object operation. | Negative service tests cover other customers, unrelated hosts and nonstaff. Review first-admin provisioning separately. |
| Staff privilege escalation | Host review, safety, finance and administration are distinct roles. Sensitive staff actions require recent MFA evidence. | Test each restricted operation with the wrong role. Provider MFA enrollment remains unconfigured. |
| Host overbooking | Marketplace claims have unique host, customer and booking constraints. Claim creation and booking evidence share a database operation. | SQLite contention and rollback tests provide local evidence. Hosted D1 contention remains a staging verification. |
| Replay or conflicting retries | Requests use actor-bound replay identifiers. Activity writes carry the expected revision. Payment provider keys derive from the booking. | Repeated identifiers preserve one logical action. Changed payloads and stale revisions must be rejected. |
| Cross-origin state change | API request checks restrict browser-origin writes. Bearer authorization is required separately. | Exercise same-origin and foreign-origin requests through the configured HTTP boundary. |
| SQL or script injection | SQL values are bound parameters. Existing React output renders untrusted feedback as text. | Preserve those entry points. No raw feedback HTML rendering is introduced. |
| Financial replay or unordered events | Callback verification precedes sandbox event ingestion. Event IDs and logical journal keys prevent repeated capture/refund entries. | Contract tests cover signature failure, repeats and refund-before-success. Actual provider callback delivery is unconfigured. |
| Changed prices or currencies | Server quote snapshots include a version and expiry. Provider events must match expected amount and currency. | Reject modified amounts, expired quotes and mismatched provider objects. Taxes remain unconfigured. |
| Journal tampering | Marketplace journal rows have update/delete rejection triggers. Corrections append financial events. | Database tests must exercise the triggers and balanced event groups. Database-administrator access still requires operational controls. |
| Unauthorized room grant | Daily adapter uses private room requests and participant/room/expiry-bound properties. | Local request construction can be tested. Paid-booking authorization, provider events and two-browser delivery remain integration gates. |
| Upload abuse or identity leakage | No production upload capability is enabled by this branch. Verification references belong in separate private records. | Secure media upload, content validation, consent and moderation remain NOT STARTED. |
| Alert loss | A persistent report or notification records intent to respond. | Provider delivery, retry worker, escalation destination and staff coverage must be exercised before a response claim. |
| Resource exhaustion | Bounded request parsing, action validation and account rate controls belong at the API boundary. | Hosted quota, load and abuse testing remain required. Do not run provider load tests against live accounts. |
| Retention failure | Demo closure waits for open reviews and removes narratives after resolution. Staging records separate public and private concerns. | A production retention schedule, deletion worker and access review still need implementation and qualified review. |

## Provider and runtime risks

The identity and payment endpoints are server configuration. Client input must not select a key host, change a provider base URL or turn on live processing. Keep secrets outside the static bundle and outside log fields.

The API remains closed unless its staging gate, independent database binding and identity settings are configured. Supplying flags alone does not establish staffed safety, approved payment processing or verified host supply.

The original owner-workspace prototype still depends on its Sites proxy identity boundary. Exposing that prototype behind an untrusted proxy requires a separate deployment review.

## Required staging exercises

- Two customers contend for one host through independent authenticated requests.
- A host requests another host's booking or room and receives a denial.
- A safety operator attempts a finance action and receives a denial.
- A suspended account loses access while a browser view remains open.
- A callback is repeated, delayed and delivered before another relevant event.
- A database restore preserves ownership, active claims and reconciled journal events.
- A report is delivered to the configured responder without exposing its narrative in general logs.

[QA evidence](QA-AND-TEST-EVIDENCE.md) records executed checks. [Production readiness](PRODUCTION-READINESS-CHECKLIST.md) records activation gates.

