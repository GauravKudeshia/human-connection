import { requireCondition as need } from "./errors.mjs";
import { createProductAnalytics } from "./analytics.mjs";
export const PRODUCT_EVENTS = Object.freeze([
  "experience_selected",
  "style_selected",
  "browse_hosts_opened",
  "language_filter_applied",
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
  "browse_hosts_opened",
  "language_filter_applied",
  "duration_selected",
  "format_selected",
  "match_requested",
  "host_viewed",
  "quote_shown",
  "rebook_started",
]);
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
  const productAnalytics = createProductAnalytics(db, {
    clock,
    authorize: check,
  });
  async function noteFailure(kind, subjectId = "current") {
    need(
      [
        "booking_conflict",
        "webhook_failed",
        "payment_mismatch",
        "database_error",
      ].includes(kind),
      "VALIDATION",
      "Choose an operational failure category.",
      400,
    );
    const subject = String(subjectId).slice(0, 128);
    await sql(
      "INSERT OR IGNORE INTO mp_operator_alerts VALUES(?,?,?,?,NULL)",
      crypto.randomUUID(),
      kind,
      subject,
      clock(),
    ).run();
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
    await sql(
      "INSERT OR IGNORE INTO mp_operator_alerts SELECT lower(hex(randomblob(16))),'financial_job_failed',id,?,NULL FROM mp_financial_jobs WHERE status='FAILED' AND attempts>=5",
      now,
    ).run();
    await sql(
      "INSERT OR IGNORE INTO mp_operator_alerts SELECT lower(hex(randomblob(16))),'video_room_failed',booking_id,?,NULL FROM mp_video_rooms WHERE (status='CLOSING' AND cleanup_attempts>=3) OR (status='PROVISIONING' AND created_at<?)",
      now,
      now - 60000,
    ).run();
    const hour = Math.floor(now / 3600000);
    await sql(
      "INSERT OR IGNORE INTO mp_operator_alerts SELECT ?,'refund_spike',?, ?,NULL WHERE (SELECT COUNT(*) FROM mp_refunds WHERE status='REFUNDED' AND updated_at>=?)>=5 AND (SELECT COUNT(*) FROM mp_refunds WHERE status='REFUNDED' AND updated_at>=?)*5>(SELECT COUNT(*) FROM mp_payments WHERE created_at>=?)",
      crypto.randomUUID(),
      String(hour),
      now,
      now - 3600000,
      now - 3600000,
      now - 3600000,
    ).run();
    await sql(
      "UPDATE mp_operator_alerts SET resolved_at=? WHERE kind='financial_job_failed' AND resolved_at IS NULL AND subject_id IN (SELECT id FROM mp_financial_jobs WHERE status='SUCCEEDED')",
      now,
    ).run();
    await sql(
      "UPDATE mp_operator_alerts SET resolved_at=? WHERE kind='video_room_failed' AND resolved_at IS NULL AND subject_id IN (SELECT booking_id FROM mp_video_rooms WHERE status='CLOSED')",
      now,
    ).run();
    await sql(
      "INSERT OR IGNORE INTO mp_notifications(id,user_id,kind,available_at,created_at) SELECT 'alert:'||a.id||':'||r.user_id,r.user_id,'operations_alert',?,? FROM mp_operator_alerts a JOIN mp_user_roles r ON r.role='admin' OR (r.role='safety' AND a.kind='urgent_case_backlog') OR (r.role='finance' AND a.kind IN ('financial_job_failed','payment_mismatch','refund_spike')) JOIN mp_users u ON u.id=r.user_id WHERE a.resolved_at IS NULL AND u.status='ACTIVE'",
      now,
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
            "INSERT OR IGNORE INTO mp_operator_alerts SELECT ?,'notification_failed',?, ?,NULL WHERE ?>=5 AND ?<> 'operations_alert'",
            crypto.randomUUID(),
            item.id,
            clock(),
            attempts,
            item.kind,
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
    const roles = await check(actor, ["safety", "finance", "admin"], true);
    return (
      await sql(
        "SELECT id,kind,subject_id,created_at FROM mp_operator_alerts WHERE resolved_at IS NULL AND (?=1 OR (?=1 AND kind='urgent_case_backlog') OR (?=1 AND kind IN ('financial_job_failed','payment_mismatch','refund_spike'))) ORDER BY created_at LIMIT 100",
        Number(roles.includes("admin")),
        Number(roles.includes("safety")),
        Number(roles.includes("finance")),
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
    ...productAnalytics,
    dispatch,
    alerts,
    refreshAlerts,
    noteFailure,
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
