# Provider integration decisions

The [continued implementation record](CONTINUED-IMPLEMENTATION-2026-11-14.md) supersedes the foundation status descriptions below for browser authentication, connected beta screens, host media, attendance, financial operations and notifications. Its evidence distinguishes local implementation from unexecuted provider-account verification.

November 14, 2026. Decisions apply to the development branch. External service approval and live activation remain separate operator actions.

## Database

Retain Cloudflare D1 for the first isolated staging implementation. Its prepared statements and batch API fit the existing Worker architecture. Reservation correctness must come from relational constraints and atomic database writes. A browser clock or a sequence of unlocked reads cannot own a claim. The branch keeps marketplace tables separate from `demo_workspaces`. A hosted contention test and restore drill remain release requirements. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)

Reconsider a dedicated coordination service or another relational deployment when measured contention, database limits or required transactions exceed the tested design. No stack migration is justified by the current prototype alone.

## Authentication

Implement a provider-neutral RS256 access-token verifier with server-configured issuer, audience and JWKS endpoint. Auth0 is an evaluated managed-provider candidate. Its documentation requires API-side signature, audience, permissions and standard-claim validation. The application separately loads account status and roles from its own database. Provider-managed sign-up, email verification, recovery and staff MFA must still be configured and exercised. [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)

The existing Sites identity remains scoped to the owner-workspace prototype. It does not provision marketplace staff or host permissions.

Configure the API access token to carry the verifier's required verified-email claim and the recent-authentication/MFA claims used for staff step-up. Exercise that tenant configuration before treating account sign-in as a working staging integration.

## Payments

Select Stripe sandbox as the first payment adapter boundary in `lib/marketplace/providers.mjs`. The adapter accepts test credentials and rejects live webhook events. The price policy and journal remain in application modules. The Connect merchant model, host onboarding and transfer design still need operator and processor decisions. [Stripe sandbox testing](https://docs.stripe.com/testing) · [Stripe Connect](https://docs.stripe.com/connect)

Connect offers charge models with different fund flows and refund/dispute responsibility. This branch does not select a final legal merchant model or initiate payouts. A paid pilot requires explicit service approval and a reviewed choice of charge and transfer structure. [Connect charge types](https://docs.stripe.com/connect/charges)

Provider callbacks require raw-body signature validation, event-ID deduplication and reconciliation to authoritative payment state. Stripe documents duplicate and unordered delivery, so a newer-looking timestamp cannot establish financial ordering by itself. [Stripe webhook behavior](https://docs.stripe.com/webhooks)

**Current integration status is IMPLEMENTED BUT NOT CONFIGURED.** Local injected-response tests can verify request construction and failure handling. Actual provider sandbox checkout, callback delivery, disputed payments and refund reconciliation need a configured test account.

## Private audio and video

Prefer Daily's REST boundary for the first controlled test because rooms and participant tokens can be created from the existing Worker without coupling business state to a browser SDK. The test adapter creates a private room and scopes token properties to a room, participant and expiry. No recording or transcription is requested. Actual two-browser delivery and reconnect behavior still need configured provider access. [Daily room API](https://docs.daily.co/reference/rest-api/rooms/create-room) · [Daily token API](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token)

Twilio Video remains an evaluated alternative. Its documented SDKs, room APIs, access tokens, reconnection guides and status callbacks cover the main technical needs. The branch has no Twilio adapter or comparative production-quality measurements. [Twilio Video documentation](https://www.twilio.com/docs/video)

Daily credentials are server-only. Creating a real test room requires the explicit test-room option as well as a configured key. A local adapter response establishes contract behavior. A genuine media delivery test must establish device permissions, two independent identities, participant presence, cleanup and provider-event handling.

## Verification, uploads and notifications

Identity-verification and introduction-media storage providers remain NOT STARTED. Choose a provider after confirming the service scope, jurisdiction, data retention and operator review process. Store verification references separately from public display information.

A notification outbox is an application boundary. An actual email or push provider, delivery callbacks, retry worker and staffed alert destination require configuration and operational exercises. No local notification record establishes that a person received an alert.

## Activation record

Before any live activation, record the approver, provider account, environment, allowed service, merchant model, secret-storage location, test evidence and rollback owner. Secret values belong in the deployment secret store. The committed environment example contains placeholders.

