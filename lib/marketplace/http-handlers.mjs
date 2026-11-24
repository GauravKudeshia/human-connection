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
import { createExperienceService } from "./experience.mjs";
import { createPrivacy, privacyPolicyFromConfig } from "./privacy.mjs";
import { createPayoutService } from "./payouts.mjs";
import { createOperationsConsole } from "./console.mjs";
import { experiences } from "../catalog.mjs";
import { recommendStyle } from "../style-recommendation.mjs";

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
export function marketplaceServices({
  db,
  config,
  service,
  clock,
  providers = {},
}) {
  const provider =
    providers.payment ||
    (typeof config.STRIPE_SANDBOX_SECRET_KEY === "string" &&
    config.STRIPE_SANDBOX_SECRET_KEY.startsWith("sk_test_")
      ? createStripeSandbox({ secretKey: config.STRIPE_SANDBOX_SECRET_KEY })
      : undefined);
  const videoProvider =
    providers.video ||
    (config.DAILY_ALLOW_TEST_ROOMS === "true" && config.DAILY_API_KEY
      ? createDailyTestProvider({
          apiKey: config.DAILY_API_KEY,
          allowTestRooms: true,
        })
      : undefined);
  const verificationProvider =
    providers.verification ||
    (typeof config.STRIPE_SANDBOX_SECRET_KEY === "string" &&
    config.STRIPE_SANDBOX_SECRET_KEY.startsWith("sk_test_")
      ? createStripeVerificationLookup({
          secretKey: config.STRIPE_SANDBOX_SECRET_KEY,
        })
      : undefined);
  const sessions = createSessionService(db, { clock, videoProvider });
  return {
    onboarding: createOnboarding(db, {
      clock,
      bucket: config.MARKETPLACE_MEDIA,
      authorize: service.authorize,
      verificationProvider,
    }),
    operations: createOperations(db, { clock, authorize: service.authorize }),
    sessions,
    payments: createPaymentService(db, { clock, provider }),
    experience: createExperienceService(db, {
      clock,
      authorize: service.authorize,
      service,
      bucket: config.MARKETPLACE_MEDIA,
    }),
    payouts: createPayoutService(db, {
      clock,
      provider,
      authorize: service.authorize,
      allowTestTransfers: config.MARKETPLACE_ALLOW_TEST_TRANSFERS === "true",
    }),
    console: createOperationsConsole(db, {
      clock,
      authorize: service.authorize,
    }),
    privacy: createPrivacy(db, {
      clock,
      authorize: service.authorize,
      bucket: config.MARKETPLACE_MEDIA,
      policy: privacyPolicyFromConfig(config),
      endSession: (actor, bookingId) => sessions.endSession(actor, bookingId),
    }),
  };
}
export async function readMarketplace(context, resource, id, filter = {}) {
  const { db, service, actor } = context,
    domain = marketplaceServices(context);
  if (resource === "bookings")
    await domain.sessions.expire({ actorId: actor.id });
  if (id && ["booking", "receipt", "activity", "session"].includes(resource))
    await domain.sessions.expire({ actorId: actor.id, bookingId: id });
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
  if (resource === "style-recommendation") {
    const { experience } = filter;
    need(
      experiences.some((item) => item.id === experience),
      "VALIDATION",
      "Choose an experience to get a recommendation.",
      400,
    );
    const { eligible } = await domain.onboarding.read(actor, "eligibility");
    const history = eligible
      ? (
          await db
            .prepare(
              `SELECT b.experience,b.status,
                CASE WHEN json_valid(b.quote) THEN json_extract(b.quote,'$.style') END AS style,
                r.rating,r.worth_it
              FROM mp_bookings b
              LEFT JOIN mp_reviews r ON r.booking_id=b.id AND r.customer_id=b.customer_id
              WHERE b.customer_id=? AND b.experience=? AND b.status='COMPLETED'
              ORDER BY b.created_at DESC,b.id DESC LIMIT 24`,
            )
            .bind(actor.id, experience)
            .all()
        ).results.map(({ worth_it, ...row }) => ({
          ...row,
          worthIt: worth_it === null ? null : worth_it === 1,
        }))
      : [];
    return recommendStyle(experience, history);
  }
  if (resource === "hosts") {
    const hosts = await service.read(actor, resource, id, filter);
    const intros = (
      await db
        .prepare(
          "SELECT host_id,id,content_type,transcript,duration_seconds FROM mp_intro_media WHERE status='APPROVED' ORDER BY created_at DESC",
        )
        .all()
    ).results;
    return domain.experience.profiles(
      actor,
      hosts.map((host) => ({
        ...host,
        intro: intros.find((intro) => intro.host_id === host.user_id) || null,
      })),
    );
  }
  if (resource === "host-quality")
    return domain.experience.quality(actor, id || actor.id);
  if (resource === "host-quality-metrics")
    return domain.operations.hostQuality(actor, filter);
  if (resource === "transfers") return domain.payouts.read(actor);
  if (resource === "privacy") return domain.privacy.queue(actor);
  if (["accounts", "booking-oversight", "availability"].includes(resource))
    return domain.console.read(actor, resource);
  if (resource === "host-draft") return domain.experience.draft(actor);
  if (resource === "photos" || resource === "my-photos")
    return domain.experience.photos(actor, resource === "photos");
  if (resource === "analytics")
    return domain.operations.analytics(actor, filter);
  if (resource === "financial-exceptions")
    return domain.operations.financialExceptions(actor);
  if (resource === "refunds") {
    await service.authorize(actor, ["finance", "admin"], true);
    return (
      await db
        .prepare(
          "SELECT r.*,p.status payment_status,p.amount_cents-COALESCE(t.refunded_cents,0) remaining_cents,tip.status tip_status,tip.amount_cents-COALESCE(tr.refunded_cents,0) tip_remaining_cents FROM mp_refunds r JOIN mp_payments p ON p.id=r.payment_id LEFT JOIN mp_payment_refund_totals t ON t.payment_id=p.id LEFT JOIN mp_tips tip ON tip.booking_id=r.booking_id LEFT JOIN mp_tip_refund_totals tr ON tr.tip_id=tip.id ORDER BY r.created_at LIMIT 100",
        )
        .all()
    ).results;
  }
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
      .prepare("SELECT id,status,amount_cents FROM mp_tips WHERE booking_id=?")
      .bind(id)
      .first();
    const baseCharge =
      payment && ["CAPTURED", "REFUNDED", "DISPUTED"].includes(payment.status)
        ? payment.amount_cents
        : 0;
    const refundTotal = payment
      ? await db
          .prepare(
            "SELECT refunded_cents FROM mp_payment_refund_totals WHERE payment_id=?",
          )
          .bind(payment.id)
          .first()
      : null;
    const baseRefund =
      refundTotal?.refunded_cents ??
      (payment?.status === "REFUNDED" ? baseCharge : 0);
    const tipCharge =
      tip && ["CAPTURED", "REFUNDED"].includes(tip.status)
        ? tip.amount_cents
        : 0;
    const tipRefundTotal = tip
      ? await db
          .prepare(
            "SELECT refunded_cents FROM mp_tip_refund_totals WHERE tip_id=?",
          )
          .bind(tip.id)
          .first()
      : null;
    const tipRefund =
      tipRefundTotal?.refunded_cents ??
      (tip?.status === "REFUNDED" ? tipCharge : 0);
    return {
      booking,
      payment,
      paymentState:
        baseRefund > 0 && baseRefund < baseCharge
          ? "PARTIALLY_REFUNDED"
          : payment?.status || "UNPAID",
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
  need(
    typeof key === "string" && key.length > 0 && key.length <= 128,
    "IDEMPOTENCY_REQUIRED",
    "A request key is required.",
    400,
  );
  if (["reserve", "replace-host"].includes(action))
    await domain.sessions.expire({ deferCleanup: true });
  else if (typeof payload.bookingId === "string" && payload.bookingId.length > 0)
    await domain.sessions.expire({ actorId: actor.id, bookingId: payload.bookingId });
  if (action === "track") return domain.operations.record(actor, payload, key);
  if (action === "replace-host")
    return domain.experience.replace(actor, payload.bookingId);
  if (action === "host-draft")
    return domain.experience.saveDraft(actor, payload);
  if (action === "photo-review")
    return domain.experience.photoReview(actor, payload);
  if (action === "privacy-request")
    return domain.privacy.request(actor, payload, key);
  if (action === "privacy-hold")
    return domain.privacy.hold(actor, payload, key);
  if (action === "privacy-retry") return domain.privacy.retry(actor, payload);
  if (action === "transfer-request")
    return domain.payouts.request(actor, payload, key);
  if (action === "transfer-approve")
    return domain.payouts.approve(actor, payload.batchId);
  if (action === "transfer-dispatch")
    return domain.payouts.dispatch(actor, payload.batchId);
  if (action === "transfer-reconcile")
    return domain.payouts.reconcile(actor, payload.batchId);
  if (action === "transfer-cancel")
    return domain.payouts.cancel(actor, payload.batchId);
  if (action === "account-status")
    return domain.console.accountStatus(actor, payload);
  if (action === "refund-decision")
    return domain.payments.reviewRefund(actor, payload, key);
  if (onboardingActions.has(action))
    return domain.onboarding.act(actor, action, payload, key);
  let result;
  if (action === "room-token")
    return domain.sessions.roomToken(actor, payload.bookingId);
  if (action === "end-session")
    return domain.sessions.endSession(actor, payload.bookingId);
  if (action === "checkout" || action === "tip") {
    if (action === "checkout")
      await domain.operations.record(
        actor,
        { name: "checkout_started", bookingId: payload.bookingId },
        "checkout:" + payload.bookingId,
        { server: true },
      );
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
  if (action === "reserve") {
    await domain.operations.startMatch(actor, key, payload.experience);
    try {
      result = await service.act(actor, action, payload, key);
      await domain.operations.finishMatch(actor, key, {
        bookingId: result.booking.id,
        outcome: "OFFERED",
      });
    } catch (error) {
      await domain.operations.finishMatch(actor, key, {
        outcome: error.code === "NO_MATCH" ? "NO_MATCH" : "FAILED",
      });
      throw error;
    }
  } else result = await service.act(actor, action, payload, key);
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
  if (action === "review" && typeof payload.worthIt === "boolean")
    await domain.operations.record(
      actor,
      { name: "worth_it_answered", bookingId: payload.bookingId },
      "worth-it:" + payload.bookingId,
      { server: true },
    );
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
