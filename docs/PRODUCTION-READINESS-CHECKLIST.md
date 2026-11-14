# Production readiness checklist

November 14, 2026. **Live launch is gated.** The development branch adds testable foundations while the public site remains the existing simulation.

## Evidence labels

- IMPLEMENTED AND TESTED means the cited code passed the specified local checks.
- IMPLEMENTED BUT NOT CONFIGURED means the code has an integration boundary that still lacks deployment configuration or external credentials.
- REQUIRES APPROVAL means an operator, provider or qualified reviewer must authorize the proposed service.
- BLOCKED means the named external dependency prevents the next verification.
- NOT STARTED means the capability still needs implementation.

## Controlled staging entry

- [ ] Deploy a dedicated staging Worker and isolated marketplace D1 binding after explicit authorization.
- [ ] Configure a managed identity tenant and exercise account creation, recovery, sign-out and staff MFA.
- [ ] Validate identity issuer, audience, JWKS rotation, account suspension and server-stored roles against that tenant.
- [ ] Implement and verify customer adult/U.S. eligibility and versioned policy acceptance before live booking.
- [ ] Apply the marketplace schema to a new database and verify both foreign keys and claim uniqueness.
- [ ] Run multi-client reservation, expiry, role and object-access tests through the configured HTTP boundary.
- [ ] Register provider test credentials and callback endpoints through server secret storage.
- [ ] Run an actual provider sandbox checkout, refund and callback replay scenario.
- [ ] Establish two independent authenticated participants in a private provider room and exercise loss of network, reconnect and cleanup.
- [ ] Verify shared activity revisions across the two browsers.
- [ ] Exercise backup and restore in a separate environment.

## Host readiness

- [ ] Complete age and identity verification through an approved provider.
- [ ] Separate legal identity references from public profile data.
- [ ] Review audition evidence for each approved experience.
- [ ] Record training, policy acceptance, review dates and re-evaluation dates.
- [ ] Moderate the authorized introduction clip and provide an accessible alternative.
- [ ] Verify payout-onboarding status through the chosen provider.
- [ ] Exercise suspension and appeal, and confirm blocked hosts leave matching immediately.

## Payment and operational readiness

- [ ] Receive processor approval for the actual service and merchant model.
- [ ] Approve charge, tax, commission, tip, refund, dispute and transfer policies.
- [ ] Reconcile sandbox provider objects against immutable application journal events.
- [ ] Configure durable webhook and outbox workers with alerts and retry limits.
- [ ] Review maker/checker requirements for the actual financial permissions.
- [ ] Assign named safety and finance operators with verified coverage hours.
- [ ] Exercise urgent reports, case assignment, escalation, account suspension and incident recovery.
- [ ] Approve jurisdiction-specific boundaries and emergency resource wording.
- [ ] Review privacy, retention, deletion exceptions and access logging.
- [ ] Complete physical-device, accessibility, browser and deployment-security verification.

## Live activation

Live payments, real stranger calls and payouts require explicit authorization under the project brief. Environment flags alone do not satisfy the checklist. Record actual evidence and a responsible owner for each checked item.

The completion record is [QA and test evidence](QA-AND-TEST-EVIDENCE.md). Remaining work and external dependencies are tracked in the [implementation roadmap](IMPLEMENTATION-ROADMAP.md).

