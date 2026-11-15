import { requireCondition as need } from "./errors.mjs";
export const PRODUCT_EVENTS = Object.freeze([
  "experience_selected",
  "style_selected",
  "duration_selected",
  "format_selected",
  "match_requested",
  "match_offered",
  "host_viewed",
  "host_accepted",
  "host_declined",
  "quote_shown",
  "checkout_started",
  "payment_succeeded",
  "session_joined",
  "session_completed",
  "session_failed",
  "worth_it_answered",
  "review_submitted",
  "favourite_added",
  "rebook_started",
  "tip_submitted",
  "refund_requested",
  "report_submitted",
]);
const clientEvents = new Set([
  "experience_selected",
  "style_selected",
  "duration_selected",
  "format_selected",
  "match_requested",
  "host_viewed",
  "quote_shown",
  "checkout_started",
  "rebook_started",
]);
const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  rate: denominator ? numerator / denominator : null,
});
/**
 * @param {any} db
 * @param {{clock?:()=>number,authorize?:(actor:any,roles?:string[],mfa?:boolean)=>Promise<any>,notificationProvider?:any}} [options]
 */
export function createOperations(
  db,
  { clock = Date.now, authorize, notificationProvider } = {},
) {
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  async function check(actor, roles = [], mfa = false) {
    need(
      typeof authorize === "function",
      "AUTH_NOT_CONFIGURED",
      "Verified authorization is required.",
      503,
    );
    return authorize(actor, roles, mfa);
  }
  async function record(actor, event, key, { server = false } = {}) {
    await check(actor);
    need(
      PRODUCT_EVENTS.includes(event.name) &&
        (server || clientEvents.has(event.name)),
      "VALIDATION",
      "Choose an allowed product event.",
      400,
    );
    need(
      typeof key === "string" && key.length > 0 && key.length <= 128,
      "VALIDATION",
      "An event request key is required.",
      400,
    );
    need(
      event.experience === undefined ||
        ["laugh", "hear", "distract"].includes(event.experience),
      "VALIDATION",
      "Choose a supported experience.",
      400,
    );
    if (event.bookingId) {
      const b = await sql(
        "SELECT customer_id,host_id FROM mp_bookings WHERE id=?",
        event.bookingId,
      ).first();
      need(
        b && [b.customer_id, b.host_id].includes(actor.id),
        "NOT_FOUND",
        "Booking not found.",
        404,
      );
    }
    const id = crypto.randomUUID();
    await sql(
      "INSERT OR IGNORE INTO mp_analytics_events VALUES(?,?,?,?,?,?,?)",
      id,
      actor.id,
      event.name,
      event.bookingId || null,
      event.experience || null,
      clock(),
      key,
    ).run();
    const stored = await sql(
      "SELECT id,name,booking_id,experience FROM mp_analytics_events WHERE user_id=? AND request_key=?",
      actor.id,
      key,
    ).first();
    need(
      stored.name === event.name &&
        stored.booking_id === (event.bookingId || null) &&
        stored.experience === (event.experience || null),
      "KEY_REUSED",
      "This request key belongs to a different event.",
    );
    return { eventId: stored.id, replayed: stored.id !== id };
  }
  async function analytics(
    actor,
    { from = clock() - 30 * 86400000, to = clock() } = {},
  ) {
    await check(actor, ["admin"], true);
    need(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from < to &&
        to <= clock() + 60000 &&
        to - from <= 366 * 86400000,
      "VALIDATION",
      "Choose a reporting window of at most one year.",
      400,
    );
    const bookings = await sql(
      "SELECT COUNT(*) requested,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed,SUM(CASE WHEN status IN ('FAILED_SERVICE','PARTIAL_DELIVERY','SAFETY_ENDED') THEN 1 ELSE 0 END) failed FROM mp_bookings WHERE created_at>=? AND created_at<?",
      from,
      to,
    ).first();
    const paid = await sql(
      "SELECT COUNT(*) n FROM mp_payments p JOIN mp_bookings b ON b.id=p.booking_id WHERE p.status IN ('CAPTURED','REFUNDED','DISPUTED') AND b.created_at>=? AND b.created_at<?",
      from,
      to,
    ).first();
    const accepted = await sql(
      "SELECT COUNT(DISTINCT b.id) n FROM mp_bookings b JOIN mp_booking_events e ON e.booking_id=b.id WHERE e.action='accept' AND b.created_at>=? AND b.created_at<?",
      from,
      to,
    ).first();
    const feedback = await sql(
      "SELECT COUNT(r.worth_it) answers,SUM(CASE WHEN r.worth_it=1 THEN 1 ELSE 0 END) yes FROM mp_reviews r JOIN mp_bookings b ON b.id=r.booking_id WHERE b.status='COMPLETED' AND b.created_at>=? AND b.created_at<?",
      from,
      to,
    ).first();
    const refunds = await sql(
      "SELECT COUNT(*) n FROM mp_refunds r JOIN mp_bookings b ON b.id=r.booking_id WHERE r.status='REFUNDED' AND b.created_at>=? AND b.created_at<?",
      from,
      to,
    ).first();
    const reports = await sql(
      "SELECT COUNT(DISTINCT booking_id) n FROM mp_safety_reports WHERE booking_id IS NOT NULL AND created_at>=? AND created_at<?",
      from,
      to,
    ).first();
    const totals = (
      await sql(
        "SELECT account,SUM(debit_cents) debit,SUM(credit_cents) credit FROM mp_ledger_entries WHERE created_at>=? AND created_at<? GROUP BY account",
        from,
        to,
      ).all()
    ).results;
    const customerNet = await sql(
      "SELECT COALESCE(SUM(debit_cents-credit_cents),0) cents FROM mp_ledger_entries WHERE account='processor_clearing' AND created_at>=? AND created_at<? AND (event_id LIKE 'capture:%' OR event_id LIKE 'refund:%' OR event_id LIKE 'tip-capture:%' OR event_id LIKE 'tip-refund:%')",
      from,
      to,
    ).first();
    const net = (name) => {
      const row = totals.find((r) => r.account === name);
      return row ? row.credit - row.debit : 0;
    };
    const selections = await sql(
      "SELECT COUNT(DISTINCT user_id) n FROM mp_analytics_events WHERE name='experience_selected' AND occurred_at>=? AND occurred_at<?",
      from,
      to,
    ).first();
    const completed = bookings.completed || 0,
      requested = bookings.requested || 0;
    const events = (
      await sql(
        "SELECT name,COUNT(*) count FROM mp_analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY name",
        from,
        to,
      ).all()
    ).results;
    const pending = await sql(
      "SELECT COUNT(*) n FROM mp_notifications WHERE status<>'DELIVERED'",
    ).first();
    const revenue = net("platform_revenue");
    const fees = 0 - net("processing_fee_expense"),
      videoCosts = 0 - net("video_expense"),
      disputeLoss = 0 - net("dispute_loss_expense");
    return {
      from,
      to,
      currency: "USD",
      definitions: {
        cohort:
          "Bookings created in the selected UTC window. Statuses reflect their current stored outcome.",
        financial:
          "Journal entries posted in the selected UTC window. Charges include base and tip principal.",
        value:
          "Yes answers divided by eligible completed-session answers; unanswered sessions are excluded from the answer denominator.",
        selection:
          "Authenticated accounts with a recorded experience selection. Anonymous visitors are unmeasured.",
      },
      counts: {
        requested,
        accepted: accepted.n,
        paid: paid.n,
        completed,
        failed: bookings.failed || 0,
        selections: selections.n,
        pendingNotifications: pending.n,
      },
      rates: {
        acceptance: ratio(accepted.n, requested),
        completion: ratio(completed, paid.n),
        worthIt: ratio(feedback.yes || 0, feedback.answers),
        valueResponse: ratio(feedback.answers, completed),
        refunds: ratio(refunds.n, paid.n),
        safetyReports: ratio(reports.n, requested),
      },
      financial: {
        customerNetCents: customerNet.cents,
        platformRevenueCents: revenue,
        processingFeesCents: fees,
        videoCostsCents: videoCosts,
        disputeLossCents: disputeLoss,
        contributionCents: revenue - fees - videoCosts - disputeLoss,
      },
      events,
    };
  }
  async function refreshAlerts() {
    const now = clock();
    await sql(
      "INSERT OR IGNORE INTO mp_operator_alerts(id,kind,subject_id,created_at) SELECT lower(hex(randomblob(16))),'urgent_case_backlog',id,? FROM mp_safety_reports WHERE severity='URGENT' AND status<>'CLOSED' AND created_at<=?",
      now,
      now - 300000,
    ).run();
    await sql(
      "UPDATE mp_operator_alerts SET resolved_at=? WHERE kind='urgent_case_backlog' AND resolved_at IS NULL AND subject_id IN (SELECT id FROM mp_safety_reports WHERE status='CLOSED')",
      now,
    ).run();
  }
  async function dispatch({ limit = 20 } = {}) {
    need(
      Number.isInteger(limit) && limit > 0 && limit <= 50,
      "VALIDATION",
      "Choose a bounded notification batch.",
      400,
    );
    await refreshAlerts();
    if (!notificationProvider?.send)
      return { configured: false, processed: 0, delivered: 0, failed: 0 };
    const now = clock();
    const pending = (
      await sql(
        "SELECT * FROM mp_notifications WHERE status IN ('PENDING','FAILED') AND available_at<=? AND attempts<5 ORDER BY created_at LIMIT ?",
        now,
        limit,
      ).all()
    ).results;
    let delivered = 0,
      failed = 0;
    for (const item of pending) {
      const owner = crypto.randomUUID(),
        leaseUntil = clock() + 60000;
      const claim = await sql(
        "INSERT INTO mp_delivery_leases VALUES(?,?,?) ON CONFLICT(notification_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mp_delivery_leases.expires_at<=?",
        item.id,
        owner,
        leaseUntil,
        clock(),
      ).run();
      if (claim.meta.changes !== 1) continue;
      const guard =
        "EXISTS(SELECT 1 FROM mp_delivery_leases WHERE notification_id=? AND owner=?)";
      const attempt = await sql(
        "UPDATE mp_notifications SET attempts=attempts+1 WHERE id=? AND status<>'DELIVERED' AND attempts<5 AND " +
          guard,
        item.id,
        item.id,
        owner,
      ).run();
      if (attempt.meta.changes !== 1) {
        await sql(
          "DELETE FROM mp_delivery_leases WHERE notification_id=? AND owner=?",
          item.id,
          owner,
        ).run();
        continue;
      }
      try {
        await notificationProvider.send({
          idempotencyKey: item.id,
          kind: item.kind,
          recipientId: item.user_id,
          bookingId: item.booking_id,
        });
        await db.batch([
          sql(
            "UPDATE mp_notifications SET status='DELIVERED' WHERE id=? AND " +
              guard,
            item.id,
            item.id,
            owner,
          ),
          sql(
            "DELETE FROM mp_delivery_leases WHERE notification_id=? AND owner=?",
            item.id,
            owner,
          ),
          sql(
            "UPDATE mp_operator_alerts SET resolved_at=? WHERE kind='notification_failed' AND subject_id=?",
            clock(),
            item.id,
          ),
        ]);
        delivered++;
      } catch {
        const attempts = item.attempts + 1,
          availableAt = clock() + Math.min(3600000, 1000 * 2 ** attempts);
        await db.batch([
          sql(
            "UPDATE mp_notifications SET status='FAILED',available_at=? WHERE id=? AND " +
              guard,
            availableAt,
            item.id,
            item.id,
            owner,
          ),
          sql(
            "DELETE FROM mp_delivery_leases WHERE notification_id=? AND owner=?",
            item.id,
            owner,
          ),
          sql(
            "INSERT OR IGNORE INTO mp_operator_alerts SELECT ?,'notification_failed',?, ?,NULL WHERE ?>=5",
            crypto.randomUUID(),
            item.id,
            clock(),
            attempts,
          ),
        ]);
        failed++;
      }
    }
    return {
      configured: true,
      processed: delivered + failed,
      delivered,
      failed,
    };
  }
  async function alerts(actor) {
    await check(actor, ["safety", "admin"], true);
    return (
      await sql(
        "SELECT id,kind,subject_id,created_at FROM mp_operator_alerts WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100",
      ).all()
    ).results;
  }
  async function financialExceptions(actor) {
    await check(actor, ["finance", "admin"], true);
    return {
      disputes: (
        await sql(
          "SELECT d.provider_id,d.payment_id,d.amount_cents,d.currency,d.status,d.updated_at,p.booking_id FROM mp_disputes d JOIN mp_payments p ON p.id=d.payment_id ORDER BY d.updated_at DESC LIMIT 100",
        ).all()
      ).results,
      jobs: (
        await sql(
          "SELECT id,payment_id,kind,status,attempts,available_at FROM mp_financial_jobs WHERE status<>'SUCCEEDED' ORDER BY available_at LIMIT 100",
        ).all()
      ).results,
    };
  }
  return {
    record,
    analytics,
    dispatch,
    alerts,
    refreshAlerts,
    financialExceptions,
  };
}

/** Delivery providers must honor the stable Idempotency-Key across retries. */
/** @param {{mode?:string,url?:string,secret?:string,fetcher?:typeof fetch}} [options] */
export function createNotificationWebhook({
  mode,
  url,
  secret,
  fetcher = fetch,
} = {}) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    need(
      false,
      "NOTIFICATIONS_NOT_CONFIGURED",
      "A sandbox delivery endpoint is required.",
      503,
    );
  }
  need(
    mode === "sandbox" &&
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password &&
      typeof secret === "string" &&
      secret.length >= 16,
    "NOTIFICATIONS_NOT_CONFIGURED",
    "Configure an authorized sandbox notification destination.",
    503,
  );
  return {
    async send({ idempotencyKey, kind, recipientId, bookingId }) {
      const response = await fetcher(endpoint.href, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          mode: "sandbox",
          kind,
          recipientId,
          bookingId: bookingId || null,
        }),
      });
      need(
        response.ok,
        "DELIVERY_FAILED",
        "Sandbox notification delivery failed.",
        503,
      );
    },
  };
}
