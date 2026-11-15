# Provider integration decisions

November 15, 2026. Current status is [Master Prompt compliance](MASTER-PROMPT-COMPLIANCE.md). Provider interfaces are implemented and locally tested with injected responses; actual account configuration, provider approval and live activation remain separate actions. The user selected local verification.

## Database

Retain Cloudflare D1 for the first isolated staging implementation. Its prepared statements and batch API fit the existing Worker architecture. Reservation correctness must come from relational constraints and atomic database writes. A browser clock or a sequence of unlocked reads cannot own a claim. The branch keeps marketplace tables separate from `demo_workspaces`. A hosted contention test and restore drill remain release requirements. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)

Reconsider a dedicated coordination service or another relational deployment when measured contention, database limits or required transactions exceed the tested design. No stack migration is justified by the current prototype alone.

## Authentication

Implement a provider-neutral RS256 access-token verifier with server-configured issuer, audience and JWKS endpoint. Auth0 is an evaluated managed-provider candidate. Its documentation requires API-side signature, audience, permissions and standard-claim validation. The application separately loads account status and roles from its own database. Provider-managed sign-up, email verification, recovery and staff MFA must still be configured and exercised. [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)

The existing Sites identity remains scoped to the owner-workspace prototype. It does not provision marketplace staff or host permissions.

Configure the API access token to carry the verifier's required verified-email claim and the recent-authentication/MFA claims used for staff step-up. Exercise that tenant configuration before treating account sign-in as a working staging integration.

## Payments

Select Stripe sandbox as the first payment adapter boundary in `lib/marketplace/providers.mjs`. The adapter accepts test credentials and rejects live webhook events. The price policy and journal remain in application modules. The production Connect merchant model and bank-payout design still need operator and processor decisions. The branch now implements reviewed test connected-account references and default-off sandbox transfers with settled journal balances, independent approval, stable retries and reversal reconciliation. [Stripe sandbox testing](https://docs.stripe.com/testing) · [Stripe Connect](https://docs.stripe.com/connect)

Connect offers charge models with different fund flows and refund/dispute responsibility. This branch does not select a final legal merchant model or initiate bank payouts. Test connected-account transfers are explicitly different from bank payouts. A paid pilot requires explicit service approval and a reviewed choice of charge and transfer structure. [Connect charge types](https://docs.stripe.com/connect/charges)

Provider callbacks require raw-body signature validation, event-ID deduplication and reconciliation to authoritative payment state. Stripe documents duplicate and unordered delivery, so a newer-looking timestamp cannot establish financial ordering by itself. [Stripe webhook behavior](https://docs.stripe.com/webhooks)

**Current integration status is IMPLEMENTED BUT NOT CONFIGURED.** Local injected-response tests can verify request construction and failure handling. Actual provider sandbox checkout, callback delivery, disputed payments and refund reconciliation need a configured test account.

## Private audio and video

Prefer Daily's REST boundary for the first controlled test because rooms and participant tokens can be created from the existing Worker without coupling business state to a browser SDK. The test adapter creates a private room and scopes token properties to a room, participant and expiry. No recording or transcription is requested. Actual two-browser delivery and reconnect behavior still need configured provider access. [Daily room API](https://docs.daily.co/reference/rest-api/rooms/create-room) · [Daily token API](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token)

Twilio Video remains an evaluated alternative. Its documented SDKs, room APIs, access tokens, reconnection guides and status callbacks cover the main technical needs. The branch has no Twilio adapter or comparative production-quality measurements. [Twilio Video documentation](https://www.twilio.com/docs/video)

Daily credentials are server-only. Creating a real test room requires the explicit test-room option as well as a configured key. A local adapter response establishes contract behavior. A genuine media delivery test must establish device permissions, two independent identities, participant presence, cleanup and provider-event handling.

## Verification, uploads and notifications

A test-only Stripe Identity/connected-account lookup checks reference ownership, verified adult/U.S. evidence and payout eligibility without persisting identity documents or birth dates. Private R2 stores authenticated, bounded introduction clips and reviewed profile photos. Real authorized provider objects, media and reviewed operating process remain unconfigured. Identity verification is separate from experience suitability.

A durable outbox with leases, capped backoff and cutoff is implemented, with a test-only HTTPS delivery abstraction and scoped alert records. An authorized destination, hosted schedule, actual delivery receipt and staffed response require configuration and operational exercises. Stable delivery keys require destination idempotency. No local record establishes human receipt.

## Activation record

Before any live activation, record the approver, provider account, environment, allowed service, merchant model, secret-storage location, test evidence and rollback owner. Secret values belong in the deployment secret store. The committed environment example contains placeholders.

## Current provider-specific scope

The managed browser flow includes hosted sign-in/recovery delegation, PKCE, nonce/state and encrypted revocable cookies using maintained JOSE. Configure and test the tenant before describing it as an operating identity integration.

The Daily browser client, paid-room authorization, signed attendance pipeline, reconnection/deadline logic and cleanup exist. Actual two-browser/network/device verification remains unexecuted.

Stripe base and tip refunds support cumulative partial/full provider evidence. Fees and disputes retain independent journal evidence. The adapter pins its tested API request contract; an API version header is not proof of account compatibility. No bank-payout dispatch, provider-side identity erasure, tax determination or live processor approval is claimed. [Stripe refund API](https://docs.stripe.com/api/refunds/create) · [Stripe transfer API](https://docs.stripe.com/api/transfers/create).
