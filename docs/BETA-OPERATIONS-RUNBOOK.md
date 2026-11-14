# Beta operations runbook

November 14, 2026. This is the operating procedure for an authorized controlled environment. The branch has no live customer operation, approved host supply or staffed-response claim.

## Before opening a controlled session

Confirm the environment identifier, marketplace database binding, authentication issuer, allowed test accounts and provider mode. Keep the static demo and its fictional Operations controls outside staff authorization.

Use server-stored roles for host review, safety and finance. Sensitive staff actions require the configured higher-assurance authentication check. Provision staff through a controlled administrative process and retain an approval record. An account's own request cannot assign staff authority.

## Host onboarding

1. The applicant submits a public display profile and the requested experiences, languages and formats.
2. A reviewer checks the separate verification reference and eligibility status.
3. The reviewer evaluates an audition for each proposed experience and records the decision and explanation.
4. Training and policy acceptance must be recorded before eligibility.
5. Approve availability only after identity, experience certification and payout prerequisites satisfy the configured policy.
6. On suspension, prevent new offers and review active reservations individually.
7. Handle an appeal through a different authorized review where the approved policy requires it.

Identity-verification vendor requests, secure introduction uploads and provider payout onboarding still require integration. A local approval record must not imply that those external checks occurred.

## Booking and provider failure

For a conflict or expired request, verify the authoritative booking state before asking the customer to retry. A host decline should release the claim and lead to another eligible choice without creating a charge.

If checkout appears successful but the session is unavailable, compare the application's quote, payment reference, provider status and signed event record. A successful payment establishes a financial event. Delivery requires separate authorized participant evidence.

For a media outage, stop new affected offers, preserve the booking and payment references, and open the applicable service review. Apply the approved partial-delivery policy. Record the recovery action and confirm that a retry cannot duplicate a charge or refund.

## Safety case handling

1. Receive the authorized report and verify the booking relationship when present.
2. Prioritize the case using the recorded urgency and category.
3. Assign a safety operator, record the action and preserve only necessary evidence.
4. Use the approved suspension or booking-ending action when warranted.
5. Record the resolution and any appeal path.
6. Check that blocking affects subsequent matching in both directions.
7. Confirm the alert reached the configured responder through delivery evidence.

For immediate danger, use the reviewed location-appropriate emergency wording. Hosts provide ordinary conversation and follow escalation guidance within their training. Clinical assessment and crisis treatment require separate professional frameworks.

A database report record does not establish that an operator received it. Email, push or paging delivery and coverage must be configured and exercised before advertising response hours.

## Refund and reconciliation

A finance operator verifies the original payment, delivered overlap evidence, prior refunds and approved policy. Use an idempotent refund request associated with that payment. Preserve the original charge and add compensating financial events.

After callback processing, compare charge, refund, fee, dispute and payout references with the provider. Investigate unmatched or inconsistent events before closing the exception. Safety permission alone does not authorize financial changes.

## Expiry and retries

The server checks authoritative expiry whenever it accesses a reservation. Configure the reconciliation runner separately so claims are also released when no clients are open. Monitor overdue claims and failed jobs.

A retry must reuse the original operation identifier. Before replaying a provider event, check the durable event state and current provider object. Never assume timestamps establish callback delivery order.

## Backup and restoration

For configured D1 environments, record the database name, schema revision and recoverable bookmark before a migration. Export a protected copy and test restoration to a separate database. Cloudflare provides plan-dependent Time Travel history. Verify the active plan's recovery window and rehearse the recovery procedure. [D1 restoration](https://developers.cloudflare.com/d1/reference/time-travel/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Pause writes during a coordinated recovery. Restore the isolated copy, reapply the intended migrations, then verify ownership, foreign keys, claims, payment references and journal reconciliation. Re-enable traffic only after the restored state passes the recorded checks.

## Incident record

Record a correlation identifier, environment, affected booking/provider references, timeline, owner, decision and recovery evidence. Keep credentials, identity documents, private conversation content and full safety narratives out of general logs.

[Readiness checklist](PRODUCTION-READINESS-CHECKLIST.md) and [threat model](SECURITY-THREAT-MODEL.md) define the remaining verification work.

