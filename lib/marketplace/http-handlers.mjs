import {
  createOnboarding,
  createStripeVerificationLookup,
} from "./onboarding.mjs";
import { createOperations } from "./operations.mjs";
import { createSessionService } from "./sessions.mjs";
import { createStripeSandbox, createDailyTestProvider } from "./providers.mjs";
import { createPaymentService } from "./finance.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { fingerprint } from "../fingerprint.mjs";

const onboardingActions = new Set([
  "customer-eligibility",
  "host-verification-review",
  "host-intro-review",
  "host-appeal",
  "appeal-decision",
]);
const onboardingReads = new Set([
  "eligibility",
  "my-intros",
  "my-appeals",
  "intros",
  "appeals",
  "verifications",
]);
export function marketplaceServices({ db, config, service }) {
  const provider =
    typeof config.STRIPE_SANDBOX_SECRET_KEY === "string" &&
    config.STRIPE_SANDBOX_SECRET_KEY.startsWith("sk_test_")
      ? createStripeSandbox({ secretKey: config.STRIPE_SANDBOX_SECRET_KEY })
      : undefined;
  const videoProvider =
    config.DAILY_ALLOW_TEST_ROOMS === "true" && config.DAILY_API_KEY
      ? createDailyTestProvider({
          apiKey: config.DAILY_API_KEY,
          allowTestRooms: true,
        })
      : undefined;
  const verificationProvider = provider
    ? createStripeVerificationLookup({
        secretKey: config.STRIPE_SANDBOX_SECRET_KEY,
      })
    : undefined;
  return {
    onboarding: createOnboarding(db, {
      bucket: config.MARKETPLACE_MEDIA,
      authorize: service.authorize,
      verificationProvider,
    }),
    operations: createOperations(db, { authorize: service.authorize }),
    sessions: createSessionService(db, { videoProvider }),
    payments: createPaymentService(db, { provider }),
  };
}
export async function readMarketplace(context, resource, id, filter = {}) {
  const { db, service, actor } = context,
    domain = marketplaceServices(context);
  await domain.sessions.expire();
  if (onboardingReads.has(resource))
    return domain.onboarding.read(actor, resource, id);
  if (resource === "me") {
    const profile = await service.read(actor, "me");
    return {
      ...profile,
      eligible: (await domain.onboarding.read(actor, "eligibility")).eligible,
    };
  }
  if (resource === "session") return domain.sessions.read(actor, id);
  if (resource === "hosts") {
    const hosts = await service.read(actor, resource, id, filter);
    const intros = (
      await db
        .prepare(
          "SELECT host_id,id,content_type,transcript,duration_seconds FROM mp_intro_media WHERE status='APPROVED' ORDER BY created_at DESC",
        )
        .all()
    ).results;
    return hosts.map((host) => ({
      ...host,
      intro: intros.find((intro) => intro.host_id === host.user_id) || null,
    }));
  }
  if (resource === "analytics")
    return domain.operations.analytics(actor, filter);
  if (resource === "financial-exceptions")
    return domain.operations.financialExceptions(actor);
  if (resource === "alerts") return domain.operations.alerts(actor);
  if (resource === "host-earnings") {
    await service.authorize(actor, ["host"]);
    const rows = (
      await db
        .prepare(
          "SELECT l.account,SUM(l.credit_cents-l.debit_cents) amount FROM mp_ledger_entries l JOIN mp_bookings b ON b.id=l.booking_id WHERE b.host_id=? AND l.account IN ('host_base_payable','host_tip_payable') GROUP BY l.account",
        )
        .bind(actor.id)
        .all()
    ).results;
    const amounts = Object.fromEntries(
      rows.map((row) => [row.account, row.amount]),
    );
    return {
      currency: "USD",
      baseCents: amounts.host_base_payable || 0,
      tipCents: amounts.host_tip_payable || 0,
      payoutsEnabled: false,
    };
  }
  if (resource === "favourites") {
    await service.authorize(actor);
    return (
      await db
        .prepare(
          "SELECT h.user_id,h.display_name,h.biography,h.languages,h.formats,h.styles FROM mp_favourites f JOIN mp_host_profiles h ON h.user_id=f.host_id WHERE f.customer_id=? AND h.status='APPROVED'",
        )
        .bind(actor.id)
        .all()
    ).results;
  }
  if (resource === "receipt") {
    const booking = await service.read(actor, "booking", id);
    const payment = await db
      .prepare(
        "SELECT id,status,amount_cents,currency,provider_id FROM mp_payments WHERE booking_id=?",
      )
      .bind(id)
      .first();
    const tip = await db
      .prepare("SELECT status,amount_cents FROM mp_tips WHERE booking_id=?")
      .bind(id)
      .first();
    const baseCharge =
      payment && ["CAPTURED", "REFUNDED", "DISPUTED"].includes(payment.status)
        ? payment.amount_cents
        : 0;
    const baseRefund = payment?.status === "REFUNDED" ? baseCharge : 0;
    const tipCharge =
      tip && ["CAPTURED", "REFUNDED"].includes(tip.status)
        ? tip.amount_cents
        : 0;
    const tipRefund = tip?.status === "REFUNDED" ? tipCharge : 0;
    return {
      booking,
      payment,
      receipt: {
        baseCharge,
        baseRefund,
        tipCharge,
        tipRefund,
        net: baseCharge - baseRefund + tipCharge - tipRefund,
        currency: booking.currency,
      },
    };
  }
  return service.read(actor, resource, id, filter);
}
export async function actMarketplace(context, action, payload, key) {
  const { service, actor, db, config } = context,
    domain = marketplaceServices(context);
  await service.authorize(actor);
  await domain.sessions.expire();
  need(
    typeof key === "string" && key.length > 0 && key.length <= 128,
    "IDEMPOTENCY_REQUIRED",
    "A request key is required.",
    400,
  );
  if (action === "track") return domain.operations.record(actor, payload, key);
  if (onboardingActions.has(action))
    return domain.onboarding.act(actor, action, payload, key);
  let result;
  if (action === "room-token")
    return domain.sessions.roomToken(actor, payload.bookingId);
  if (action === "end-session")
    return domain.sessions.endSession(actor, payload.bookingId);
  if (action === "checkout" || action === "tip") {
    result =
      action === "checkout"
        ? await domain.payments.checkout(actor, payload.bookingId)
        : await domain.payments.tip(
            actor,
            payload.bookingId,
            payload.cents,
            key,
          );
    return {
      ...result,
      publishableKey:
        typeof config.STRIPE_SANDBOX_PUBLISHABLE_KEY === "string" &&
        config.STRIPE_SANDBOX_PUBLISHABLE_KEY.startsWith("pk_test_")
          ? config.STRIPE_SANDBOX_PUBLISHABLE_KEY
          : null,
    };
  }
  if (action === "refund-dispatch")
    return domain.payments.dispatchRefund(actor, payload.refundId);
  if (action === "tip-refund")
    return domain.payments.refundTip(actor, payload.bookingId);
  if (action === "reconcile")
    return domain.payments.reconcile(actor, payload.paymentId);
  result = await service.act(actor, action, payload, key);
  if (action === "report" && payload.urgent && payload.bookingId)
    await domain.sessions.endSession(actor, payload.bookingId, "SAFETY");
  if (action === "block") {
    const live = (
      await db
        .prepare(
          "SELECT id FROM mp_bookings WHERE status IN ('READY','LIVE') AND ((customer_id=? AND host_id=?) OR (host_id=? AND customer_id=?))",
        )
        .bind(actor.id, payload.userId, actor.id, payload.userId)
        .all()
    ).results;
    for (const booking of live)
      await domain.sessions.endSession(actor, booking.id, "SAFETY");
  }
  const event = {
    reserve: "match_offered",
    accept: "host_accepted",
    decline: "host_declined",
    review: "review_submitted",
    favourite: "favourite_added",
    "refund-request": "refund_requested",
    report: "report_submitted",
  }[action];
  if (event) {
    try {
      await domain.operations.record(
        actor,
        {
          name: event,
          bookingId: payload.bookingId || result.booking?.id,
          experience: payload.experience,
        },
        fingerprint(key + ":" + event),
        { server: true },
      );
    } catch {
      /* Business records remain authoritative if optional event projection fails. */
    }
  }
  return result;
}
export async function boundedJson(request, limit = 12000) {
  need(
    request.headers.get("content-type")?.startsWith("application/json"),
    "JSON_REQUIRED",
    "JSON is required.",
    415,
  );
  const reader = request.body?.getReader();
  need(reader, "VALIDATION", "A request body is required.", 400);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new MarketplaceError("TOO_LARGE", "The request is too large.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MarketplaceError("VALIDATION", "Valid JSON is required.", 400);
  }
}
