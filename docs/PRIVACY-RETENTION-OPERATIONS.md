# Privacy and retention operations

November 15, 2026. Code: `lib/marketplace/privacy.mjs`. Evidence: `tests/marketplace-privacy.test.mjs` and boundary tests. All executed erasure tests use disposable fictional records.

Account closure and private-data erasure are different operations. The authenticated `privacy-request` action requires an explicit confirmation and request key. It immediately closes access, revokes sessions/roles, removes eligibility/availability and cancels unpaid requests. Active paid sessions end through the trusted session service. An atomic closure guard retries if a concurrent capture becomes ready between the initial snapshot and the closure transaction. Staff accounts require a prior responsibility handoff.

The response issues a random private receipt token; the database stores its hash. `POST /api/marketplace/privacy-receipt` accepts it in bounded same-origin JSON and returns minimal request state. Keep it out of URLs, logs and support messages. Authenticated closure retries do not mint a replacement token. Provider-subject hashes prevent an erased identity silently recreating the account; provisioning also checks this atomically.

## Reviewed policy only

`MARKETPLACE_PRIVACY_PURGE_ENABLED=false` is the default. No legal retention duration is assumed. Configure an approved version and every explicit duration in `.env.example` only after qualified review. A queued request snapshots that policy; changing later configuration cannot silently shorten its accepted retention requirements. With no reviewed policy, closure works and erasure waits.

The scheduled worker runs bounded leased processing and reviewed expiry sweeps. Active sessions, unsettled money, open safety cases, active uploads and legal/financial/safety holds defer erasure. Failed cleanup can be retried by an administrator with MFA and an explanation. Holds and releases are audited. Only administrators can inspect the privacy queue or modify holds.

Erasure removes/tombstones public/private profile data, introduction/photo objects, drafts, verification references, private feedback and eligible account-linked operational/analytics records. It preserves pseudonymized ledger, policy, transition and audit evidence according to the reviewed operating policy. A retained financial reference is not an authorization to collect fresh personal data.

R2 and SQLite do not share one transaction. Workers renew their live lease and recheck holds before deleting each object; SQL redaction is lease-gated. A hold placed after an object was legitimately deleted cannot recreate its bytes. Treat the hold boundary and restore policy as an operator decision, and exercise real bucket failure/recovery before launch. Post-upload account checks and cleanup prevent a closure race from publishing newly uploaded media.

External identity/payment/video provider account deletion is a separate operation and has not been implemented or executed. Define the approved process and retention exceptions before live operation. Hosted export/restore, real access requests and policy review remain unverified.
