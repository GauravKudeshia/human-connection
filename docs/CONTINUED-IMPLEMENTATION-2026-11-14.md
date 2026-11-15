# Continued marketplace implementation

November 14, 2026 · development branch `feature/research-driven-beta-foundation`

## Implemented since the foundation review

| Capability | Working code and local evidence | External verification |
| --- | --- | --- |
| Browser sign-in and sign-out | OIDC authorization-code flow, PKCE, state and nonce, maintained JOSE verification, encrypted HttpOnly cookie, database revocation and MFA recency. Three browser-auth tests exercise the exchange with a local provider fixture. | Configure the managed identity tenant, client and application origin. |
| Customer, host and staff interfaces | `app/beta/` calls the authorized marketplace API. Customer eligibility, profile choice, reservations, quotes, Stripe Payment Element, sessions, activities, feedback, favorites and receipts have connected controls. Host Studio exposes applications, clips, availability and acceptance. Staff queues expose scoped reviews and metrics. | Exercise accounts and provider SDKs through the configured staging service. |
| Customer eligibility and policy history | Server-owned adult/U.S. acknowledgement and versioned policy records gate reservations. Acceptance history is append-only. | Qualified review must approve the actual service policy and age-assurance requirements. |
| Host introductions and appeals | Authenticated bounded R2 upload, type/magic validation, consent, transcript, manual duration confirmation, private review and approved playback. Suspended/rejected hosts can appeal to a different authorized reviewer. | Configure the private bucket and exercise real authorized test media. |
| Host verification | A sandbox-only Stripe Identity/account lookup validates provider references, account ownership metadata, verified adult/U.S. evidence and payout eligibility. Identity documents and birth dates remain outside application persistence. | Configure the selected approved provider accounts and verification process. |
| Private media and attendance | Paid/approved participant room grants, Daily client controls, signed callbacks, idempotent attendance intervals, reconnection overlap, independent termination and cleanup retries. Completed delivery requires trusted dual attendance. | An authorized Daily test account and two-browser device/network exercises are still required. |
| Financial operations | Sandbox tips preserve host principal, delivered base allocation is versioned, refunds reverse earned allocations, provider fees are separate, disputes retain financial evidence, and leased jobs retry approved refunds. | Reconcile actual Stripe sandbox captures, fees, refunds and dispute callbacks. |
| Notifications and operational alerts | Persistent outbox leases, stable delivery keys, bounded backoff, five-attempt cutoff and alert records. Scheduled processing runs session expiry before generic expiry and retries financial/notification work. | Configure an authorized sandbox delivery destination and schedule. |
| Analytics and host earnings | Date-filtered, permission-restricted counts, explicit denominators, journal-derived net/revenue/fees/contribution and scoped host base/tip earnings. Customer navigation events use an allowlist. | Genuine business conversion and repeat-purchase conclusions require actual authorized service activity. |
| Backup exercise | A quiesced SQLite copy restores ownership, roles, claim constraints, integrity and foreign-key checks in a separate fixture. | Run the hosted D1 export/restore drill against staging. |

## Local evidence

The final local suite contains 130 passing tests. This includes the original regression suite and additional browser-auth, interface transport, onboarding, media, operations, attendance, financial and restore tests. ESLint, TypeScript, the Worker build and Pages build are checked separately.

The normalized schema plus the three additive migrations execute with local D1. The original prototype HTTP suite also runs against disposable data. The actual Worker serves `/beta` and returns a clear unconfigured account state with the default settings.

Browser checks used 320, 390, 768 and 1440 pixels. Authenticated customer/host/staff views used a clearly labeled UI fixture with fictional responses. Those checks exercised customer acknowledgement, host discovery and requests, host acceptance, introduction controls, staff analytics and a case assignment. The actual Worker entry was checked separately. The fixture adapted Next's link/image components for standalone rendering. Initial fixture bundling errors were fixed in that test harness.

## Remaining gates and engineering work

The user selected local verification for this iteration. Actual managed-provider sign-in, Stripe test-account checkout and two-person Daily sessions remain unexecuted. Production publishing, real money, host payouts and stranger calls remain gated by the original brief.

A complete live pilot still requires approved policies and merchant structure, real host verification and auditions, identity/media provider configuration, staffed safety coverage, hosted contention and restoration tests, physical-device and specialist accessibility checks, and reconciliation against real sandbox provider objects. Partial monetary refunds, production payout dispatch, automated retention/deletion and full commercial cohort reporting need further implementation or a reviewed operating policy. The existing code supports full-refund review and sandbox compensation.

No evidence in this document represents real customer activity, actual provider approval or a production-readiness certification.

