# Beta operations runbook

November 15, 2026. This describes an authorized controlled environment. No actual host supply, staffed safety response, real payout or public beta operation has been established.

## Environment and access

Confirm the isolated D1/R2, issuer/client/origin, provider test mode, approved test actors and scheduled worker. Keep the public simulator separate. Bootstrap staff roles through a trusted operator. Host review, safety, finance and administration are different roles; sensitive actions require recent MFA. Record incident/request references, owners and decisions without logging credentials, documents or private narratives.

## Host quality

Applicants can save a draft, submit a profile, accept policy/training and upload consented introduction/photo media. Verify provider-owned identity/payout references separately from public profile data. Review the clip/transcript/photo and record the decision. Audition and certify each experience separately, with rubric/version/re-evaluation date. Identity verification does not establish hosting suitability. Approved availability still requires recent heartbeat and an unclaimed eligible host. Handle rejection/suspension appeals through a different reviewer.

Before live host approval, qualified reviewers must approve actual policy/training materials and age/jurisdiction/identity assurance. Hosts sell bounded ordinary human experiences. They must not diagnose, promise emotional outcomes, solicit off-platform money, pursue romantic/sexual interaction or claim a customer's personal friendship. For distressed users or imminent danger, use the reviewed location-appropriate emergency guidance and escalation process; no clinical assessment is promised by this code.

## Booking and delivery

Read the authoritative booking before retrying. A decline/expiry can lead to another eligible unpaid request while preserving choices; neither searching nor being declined creates a charge. A started payment prevents automatic replacement and requires resolution. Inspect the quote, payment reference, immutable events and provider state when checkout and UI disagree.

Provider attendance establishes delivery. A successful payment alone does not. Neither participant joining must produce failed-service review, including when no room was provisioned. Insufficient overlap, early termination and safety ending remain distinct from completion. End/report/block controls work independently. Room cleanup can be pending; inspect retries and provider state before reopening service.

## Safety and account actions

Prioritize reports, assign an authorized reviewer, preserve necessary evidence and record resolution/escalation. A safety operator may suspend the reported account only through an assigned open case; administrators have separate authority. Suspension revokes sessions, removes availability, ends affected bookings, releases claims and queues captured payments for finance review. Account reinstatement is an administrator action and does not silently reapprove a host profile. Confirm bilateral blocks exclude subsequent matching.

Reports and alert records do not prove human receipt. Configure an authorized sandbox delivery destination and verify receipt, retry cutoff and on-call ownership. Do not advertise response hours before staff coverage exists.

## Financial review

Use finance/admin MFA. Inspect trusted overlap, the original charge, cumulative refunds, prior awards, fees/disputes and the approved policy. An optional refund amount awards part of the remaining principal; blank awards the remaining amount. Awards are immutable and dispatch uses a stable provider key. Only confirmed callback/reconciliation evidence posts refund compensation. Another review can reopen the remaining principal without duplicating an earlier request.

Tip principal is tracked separately; partial external tip refunds converge cumulatively. Finance can refund remaining tip principal on a fully refunded base booking. Retry jobs keep a fixed amount/key even after an ambiguous provider response.

Sandbox connected-account transfers use settled journal balances and global holds, require another finance approver, then submission and reconciliation. Cancellation is available only before any ambiguous submission. Compare reversal evidence and resulting liabilities before approving new funds. These are test transfers, not bank payouts. No live merchant, tax or payout arrangement is selected.

## Privacy, scheduled work and incidents

Use the [privacy guide](PRIVACY-RETENTION-OPERATIONS.md) for account closure, private receipt lookup, reviewed retention snapshots, holds/releases and failed-job retry. Destructive processing remains off until all policy durations are approved. External identity/provider account erasure is a separate missing process.

The minute schedule reconciles sessions/claims, financial retries, outbox alerts, optional visitor expiry and reviewed privacy jobs. Monitor failed financial jobs, room provisioning/cleanup, refund spikes, webhook failures, booking conflicts, database errors and urgent cases. Alert routing separates safety from finance; failed staff notifications do not create infinite alert chains.

For an incident: gate affected new operations, identify the environment/request and booking/provider references, assign an owner, preserve state/evidence, reconcile ambiguous provider effects using original keys, and record recovery before resuming. Never reset production data to make a test pass.

## Backup and restore

Before hosted migration, record schema versions and a protected export/bookmark. Restore to an isolated database while writes are coordinated; verify integrity, foreign keys, roles, ownership, claims, callbacks and journal reconciliation before traffic resumes. Local quiesced restore is tested. Hosted D1 restore and the plan's recovery window still need verification. [Cloudflare D1 restoration](https://developers.cloudflare.com/d1/reference/time-travel/).
