import { requireCondition as need } from "./errors.mjs";

const DAY = 86400000;
const VISITOR_RETENTION = 31 * DAY;
const HEARTBEAT_TTL = 90000;
export const ANALYTICS_CONSENT_VERSION = "analytics-v1";
const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  rate: denominator ? numerator / denominator : null,
});
const hex = (bytes) =>
  [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const tokenHash = async (token) =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
const validToken = (token) =>
  typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
const requestKey = (key) =>
  need(
    typeof key === "string" && key.length > 0 && key.length <= 128,
    "VALIDATION",
    "A bounded request key is required.",
    400,
  );

export function unionIntervals(intervals) {
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result[result.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else result.push([start, end]);
  }
  return result;
}
const duration = (intervals) =>
  intervals.reduce((sum, [a, b]) => sum + b - a, 0);
function intersection(a, b) {
  const result = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]),
      end = Math.min(a[i][1], b[j][1]);
    if (end > start) result.push([start, end]);
    if (a[i][1] <= b[j][1]) i++;
    else j++;
  }
  return result;
}
const quantile = (sorted, p) =>
  sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;

/** Source-backed metrics. Client events cannot create purchases, attendance or financial facts. */
export function createProductAnalytics(
  db,
  { clock = Date.now, authorize } = {},
) {
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const first = (query, ...args) => sql(query, ...args).first();
  const all = async (query, ...args) =>
    (await sql(query, ...args).all()).results;
  async function check(actor, roles = [], mfa = false) {
    need(
      typeof authorize === "function",
      "AUTH_NOT_CONFIGURED",
      "Verified authorization is required.",
      503,
    );
    return authorize(actor, roles, mfa);
  }
  async function visitor(token, { active = true } = {}) {
    if (!validToken(token)) return null;
    return first(
      "SELECT id,expires_at FROM mp_visit_sessions WHERE token_hash=?" +
        (active ? " AND expires_at>?" : ""),
      ...[await tokenHash(token), ...(active ? [clock()] : [])],
    );
  }
  async function startVisitor({ consent, consentVersion, token } = {}) {
    need(
      consent === true && consentVersion === ANALYTICS_CONSENT_VERSION,
      "CONSENT_REQUIRED",
      "Optional analytics require an explicit current acknowledgement.",
      400,
    );
    const existing = await visitor(token);
    if (existing)
      return {
        token,
        expiresAt: existing.expires_at,
        consentVersion: ANALYTICS_CONSENT_VERSION,
        replayed: true,
      };
    const next = hex(crypto.getRandomValues(new Uint8Array(32))),
      now = clock();
    const inserted = await db.batch([
      sql(
        "INSERT INTO mp_visit_sessions(id,token_hash,consent_version,started_at,expires_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM mp_visit_sessions WHERE started_at>=?)<1000",
        crypto.randomUUID(),
        await tokenHash(next),
        ANALYTICS_CONSENT_VERSION,
        now,
        now + DAY,
        now - 60000,
      ),
      sql(
        "INSERT OR IGNORE INTO mp_analytics_coverage VALUES('visitors',?)",
        now,
      ),
    ]);
    need(
      inserted[0].meta.changes === 1,
      "RATE_LIMITED",
      "Visit measurement is temporarily busy.",
      429,
    );
    return {
      token: next,
      expiresAt: now + DAY,
      consentVersion: ANALYTICS_CONSENT_VERSION,
      replayed: false,
    };
  }
  async function recordVisitor(token, event, key) {
    requestKey(key);
    need(
      event?.name === "experience_selected",
      "VALIDATION",
      "Choose an allowed visitor event.",
      400,
    );
    const session = await visitor(token);
    need(
      session,
      "CONSENT_REQUIRED",
      "A current optional analytics session is required.",
      403,
    );
    const now = clock();
    const result = await db.batch([
      sql(
        "INSERT OR IGNORE INTO mp_visit_events SELECT ?,?,'experience_selected',? WHERE EXISTS(SELECT 1 FROM mp_visit_sessions WHERE id=? AND expires_at>?)",
        session.id,
        key,
        now,
        session.id,
        now,
      ),
      sql(
        "UPDATE mp_visit_sessions SET selected_at=COALESCE(selected_at,?) WHERE id=? AND expires_at>?",
        now,
        session.id,
        now,
      ),
    ]);
    need(
      result[1].meta.changes === 1,
      "CONSENT_REQUIRED",
      "A current optional analytics session is required.",
      403,
    );
    return { recorded: true, replayed: result[0].meta.changes === 0 };
  }
  async function forgetVisitor(token) {
    const session = await visitor(token, { active: false });
    if (session)
      await sql("DELETE FROM mp_visit_sessions WHERE id=?", session.id).run();
    return { forgotten: true };
  }
  async function pruneAnalytics() {
    const cutoff = clock() - VISITOR_RETENTION;
    const result = await sql(
      "DELETE FROM mp_visit_sessions WHERE started_at<?",
      cutoff,
    ).run();
    return { visitorSessionsDeleted: result.meta.changes };
  }
  async function startMatch(actor, key, experience) {
    await check(actor, ["customer"]);
    requestKey(key);
    need(
      ["laugh", "hear", "distract"].includes(experience),
      "VALIDATION",
      "Choose a supported experience.",
      400,
    );
    await sql(
      "INSERT OR IGNORE INTO mp_match_attempts VALUES(?,?,?,?,'STARTED',NULL,?,NULL)",
      crypto.randomUUID(),
      actor.id,
      key,
      experience,
      clock(),
    ).run();
    const result = await first(
      "SELECT id,experience,outcome,booking_id FROM mp_match_attempts WHERE customer_id=? AND request_key=?",
      actor.id,
      key,
    );
    need(
      result.experience === experience,
      "KEY_REUSED",
      "This request key belongs to another matching request.",
    );
    return {
      attemptId: result.id,
      outcome: result.outcome,
      bookingId: result.booking_id,
    };
  }
  async function finishMatch(actor, key, { bookingId, outcome } = {}) {
    await check(actor, ["customer"]);
    requestKey(key);
    need(
      ["OFFERED", "NO_MATCH", "FAILED"].includes(outcome),
      "VALIDATION",
      "Choose a matching outcome.",
      400,
    );
    const attempt = await first(
      "SELECT * FROM mp_match_attempts WHERE customer_id=? AND request_key=?",
      actor.id,
      key,
    );
    need(attempt, "NOT_FOUND", "Matching request not found.", 404);
    if (outcome === "OFFERED") {
      const b = await first(
        "SELECT id FROM mp_bookings WHERE id=? AND customer_id=? AND experience=?",
        bookingId || "",
        actor.id,
        attempt.experience,
      );
      need(b, "NOT_FOUND", "Booking not found.", 404);
    } else
      need(
        !bookingId,
        "VALIDATION",
        "Failed matching cannot claim a booking.",
        400,
      );
    await sql(
      "UPDATE mp_match_attempts SET outcome=?,booking_id=?,finished_at=? WHERE id=? AND outcome='STARTED'",
      outcome,
      bookingId || null,
      clock(),
      attempt.id,
    ).run();
    const saved = await first(
      "SELECT outcome,booking_id FROM mp_match_attempts WHERE id=?",
      attempt.id,
    );
    need(
      saved.outcome === outcome && saved.booking_id === (bookingId || null),
      "KEY_REUSED",
      "This matching request already has a different outcome.",
    );
    return {
      attemptId: attempt.id,
      outcome: saved.outcome,
      bookingId: saved.booking_id,
    };
  }
  const purchasesSql = `WITH purchases AS (
    SELECT b.id booking_id,b.customer_id,b.host_id,MIN(l.created_at) paid_at
    FROM mp_bookings b JOIN mp_payments p ON p.booking_id=b.id
    JOIN mp_ledger_entries l ON l.payment_id=p.id AND l.account='processor_clearing'
      AND l.event_id='capture:'||p.id AND l.debit_cents>0
    GROUP BY b.id,b.customer_id,b.host_id
  ), ordered AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY customer_id ORDER BY paid_at,booking_id) purchase_order FROM purchases
  )`;
  async function retention(from, to, days) {
    const horizon = days * DAY,
      observedThrough = Math.min(to, clock());
    const row = await first(
      purchasesSql +
        ` SELECT COUNT(*) cohort,
      COALESCE(SUM(CASE WHEN p.paid_at+?<=? THEN 1 ELSE 0 END),0) eligible,
      COALESCE(SUM(CASE WHEN p.paid_at+?<=? AND EXISTS(SELECT 1 FROM purchases q
        WHERE q.customer_id=p.customer_id AND q.booking_id<>p.booking_id
        AND (q.paid_at>p.paid_at OR (q.paid_at=p.paid_at AND q.booking_id>p.booking_id))
        AND q.paid_at<=p.paid_at+?) THEN 1 ELSE 0 END),0) returned
      FROM ordered p WHERE purchase_order=1 AND paid_at>=? AND paid_at<?`,
      horizon,
      observedThrough,
      horizon,
      observedThrough,
      horizon,
      from,
      to,
    );
    return {
      ...ratio(row.returned, row.eligible),
      cohortCustomers: row.cohort,
      immatureCustomers: row.cohort - row.eligible,
      horizonDays: days,
    };
  }
  async function utilization(from, to, hostId) {
    const observations = await all(
      "SELECT * FROM mp_availability_observations WHERE observed_at>=? AND observed_at<?" +
        (hostId ? " AND host_id=?" : "") +
        " ORDER BY host_id,observed_at",
      from - HEARTBEAT_TTL,
      to,
      ...(hostId ? [hostId] : []),
    );
    const presence = await all(
      `SELECT p.*,b.customer_id,b.host_id,t.started_at,t.ended_at,b.duration
      FROM mp_session_presence p JOIN mp_bookings b ON b.id=p.booking_id
      JOIN mp_session_timing t ON t.booking_id=b.id
      WHERE p.joined_at<? AND COALESCE(p.left_at,?)>?` +
        (hostId ? " AND b.host_id=?" : ""),
      to,
      to,
      from,
      ...(hostId ? [hostId] : []),
    );
    const hostIds = new Set([
      ...observations.map((x) => x.host_id),
      ...presence.map((x) => x.host_id),
    ]);
    const hosts = [];
    for (const hostId of hostIds) {
      const heartbeats = observations.filter((x) => x.host_id === hostId);
      const available = unionIntervals(
        heartbeats.flatMap((x, i) =>
          x.available === 1
            ? [
                [
                  Math.max(from, x.observed_at),
                  Math.min(
                    to,
                    x.observed_at + HEARTBEAT_TTL,
                    heartbeats[i + 1]?.observed_at ?? Infinity,
                  ),
                ],
              ]
            : [],
        ),
      );
      const bookingIds = new Set(
        presence.filter((x) => x.host_id === hostId).map((x) => x.booking_id),
      );
      const busy = [];
      for (const bookingId of bookingIds) {
        const rows = presence.filter((x) => x.booking_id === bookingId);
        const b = rows[0],
          deadline =
            b.started_at === null ? to : b.started_at + b.duration * 60000;
        const interval = (userId) =>
          unionIntervals(
            rows
              .filter((x) => x.user_id === userId)
              .map((x) => [
                Math.max(from, x.joined_at, b.started_at ?? from),
                Math.min(to, x.left_at ?? to, b.ended_at ?? to, deadline),
              ]),
          );
        busy.push(...intersection(interval(hostId), interval(b.customer_id)));
      }
      const observedBusy = unionIntervals(busy),
        availableMs = duration(available),
        busyMs = duration(intersection(available, observedBusy));
      hosts.push({
        hostId,
        availableMs,
        busyMs,
        unobservedBusyMs: duration(observedBusy) - busyMs,
        rate: availableMs ? busyMs / availableMs : null,
      });
    }
    const availableMs = hosts.reduce((n, x) => n + x.availableMs, 0),
      busyMs = hosts.reduce((n, x) => n + x.busyMs, 0);
    return {
      availableMs,
      busyMs,
      unobservedBusyMs: hosts.reduce((n, x) => n + x.unobservedBusyMs, 0),
      rate: availableMs ? busyMs / availableMs : null,
      observedHosts: hosts.filter((x) => x.availableMs > 0).length,
      hosts,
    };
  }
  async function analytics(
    actor,
    { from = clock() - 30 * DAY, to = clock() } = {},
  ) {
    await check(actor, ["admin"], true);
    need(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from < to &&
        to <= clock() + 60000 &&
        to - from <= 366 * DAY,
      "VALIDATION",
      "Choose a reporting window of at most one year.",
      400,
    );
    const b = await first(
      `SELECT COUNT(*) requested,
      COALESCE(SUM(status='COMPLETED'),0) completed,
      COALESCE(SUM(status IN ('FAILED_SERVICE','PARTIAL_DELIVERY','SAFETY_ENDED')),0) failed
      FROM mp_bookings WHERE created_at>=? AND created_at<?`,
      from,
      to,
    );
    const counts = await first(
      `SELECT
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_booking_events e WHERE e.booking_id=b.id AND e.action='accept') THEN b.id END) accepted,
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_payments p WHERE p.booking_id=b.id AND p.status IN ('CAPTURED','REFUNDED','DISPUTED')) THEN b.id END) paid,
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_payments p WHERE p.booking_id=b.id) OR EXISTS(SELECT 1 FROM mp_analytics_events e WHERE e.booking_id=b.id AND e.name='checkout_started') THEN b.id END) checkout,
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_session_timing t WHERE t.booking_id=b.id AND t.started_at IS NOT NULL) AND EXISTS(SELECT 1 FROM mp_payments p WHERE p.booking_id=b.id AND p.status IN ('CAPTURED','REFUNDED','DISPUTED')) THEN b.id END) started,
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_ledger_entries l WHERE l.booking_id=b.id AND l.account='processor_clearing' AND l.credit_cents>0 AND l.event_id LIKE 'refund:%') THEN b.id END) refunded,
      COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM mp_safety_reports r WHERE r.booking_id=b.id) THEN b.id END) reported
      FROM mp_bookings b WHERE b.created_at>=? AND b.created_at<?`,
      from,
      to,
    );
    const feedback = await first(
      `SELECT COUNT(r.worth_it) answers,COALESCE(SUM(r.worth_it=1),0) yes
      FROM mp_reviews r JOIN mp_bookings b ON b.id=r.booking_id WHERE b.status='COMPLETED' AND b.created_at>=? AND b.created_at<?`,
      from,
      to,
    );
    const attempts = await first(
      `SELECT COUNT(*) requested,COALESCE(SUM(outcome='OFFERED'),0) offered,
      COALESCE(SUM(outcome='NO_MATCH'),0) no_match,COALESCE(SUM(outcome='STARTED'),0) pending,
      COALESCE(SUM(EXISTS(SELECT 1 FROM mp_booking_events e WHERE e.booking_id=a.booking_id AND e.action='accept')),0) accepted
      FROM mp_match_attempts a WHERE started_at>=? AND started_at<?`,
      from,
      to,
    );
    const times = (
      await all(
        `SELECT MIN(e.created_at)-a.started_at latency FROM mp_match_attempts a
      JOIN mp_booking_events e ON e.booking_id=a.booking_id AND e.action='accept'
      WHERE a.started_at>=? AND a.started_at<? GROUP BY a.id HAVING latency>=0 ORDER BY latency`,
        from,
        to,
      )
    ).map((x) => x.latency);
    const visitors = await first(
      `SELECT COUNT(*) visitors,COALESCE(SUM(selected_at IS NOT NULL AND selected_at<?),0) selected
      FROM mp_visit_sessions WHERE started_at>=? AND started_at<? AND started_at>=?`,
      to,
      from,
      to,
      clock() - VISITOR_RETENTION,
    );
    const visitorBegan = await first(
      "SELECT began_at FROM mp_analytics_coverage WHERE name='visitors'",
    );
    const selections = await first(
      "SELECT COUNT(DISTINCT user_id) n FROM mp_analytics_events WHERE name='experience_selected' AND occurred_at>=? AND occurred_at<?",
      from,
      to,
    );
    const totals = await all(
      "SELECT account,SUM(debit_cents) debit,SUM(credit_cents) credit FROM mp_ledger_entries WHERE created_at>=? AND created_at<? GROUP BY account",
      from,
      to,
    );
    const net = (name) => {
      const r = totals.find((x) => x.account === name);
      return r ? r.credit - r.debit : 0;
    };
    const money = await first(
      `SELECT
      COALESCE(SUM(CASE WHEN event_id LIKE 'capture:%' THEN debit_cents ELSE 0 END),0) gmv,
      COALESCE(SUM(CASE WHEN event_id LIKE 'tip-capture:%' THEN debit_cents ELSE 0 END),0) tips,
      COALESCE(SUM(CASE WHEN event_id LIKE 'refund:%' OR event_id LIKE 'tip-refund:%' THEN credit_cents ELSE 0 END),0) refunds,
      COALESCE(SUM(CASE WHEN event_id LIKE 'capture:%' OR event_id LIKE 'refund:%' OR event_id LIKE 'tip-capture:%' OR event_id LIKE 'tip-refund:%' THEN debit_cents-credit_cents ELSE 0 END),0) customer_net
      FROM mp_ledger_entries WHERE account='processor_clearing' AND created_at>=? AND created_at<?`,
      from,
      to,
    );
    const deliveredContribution = await first(
      `SELECT COALESCE(SUM(CASE WHEN l.account='platform_revenue' THEN l.credit_cents-l.debit_cents
      WHEN l.account IN ('processing_fee_expense','video_expense','dispute_loss_expense') THEN l.credit_cents-l.debit_cents ELSE 0 END),0) cents
      FROM mp_ledger_entries l JOIN mp_bookings b ON b.id=l.booking_id
      WHERE b.status='COMPLETED' AND b.created_at>=? AND b.created_at<? AND l.created_at<?`,
      from,
      to,
      to,
    );
    const rebook = await first(
      purchasesSql +
        ` SELECT COUNT(*) total,
      COALESCE(SUM(EXISTS(SELECT 1 FROM purchases q WHERE q.customer_id=p.customer_id AND q.host_id=p.host_id
      AND (q.paid_at<p.paid_at OR (q.paid_at=p.paid_at AND q.booking_id<p.booking_id)))),0) repeated
      FROM purchases p WHERE paid_at>=? AND paid_at<?`,
      from,
      to,
    );
    const pending = await first(
      "SELECT COUNT(*) n FROM mp_notifications WHERE status<>'DELIVERED'",
    );
    const events = await all(
      "SELECT name,COUNT(*) count FROM mp_analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY name",
      from,
      to,
    );
    const revenue = net("platform_revenue"),
      fees = -net("processing_fee_expense"),
      video = -net("video_expense"),
      loss = -net("dispute_loss_expense");
    return {
      from,
      to,
      currency: "USD",
      definitions: {
        cohort:
          "Bookings created in the selected UTC window. Statuses reflect their current stored outcome; this is not an historical status snapshot.",
        financial:
          "Journal entries posted in the selected UTC window. GMV is captured base principal before refunds; tips are separate.",
        value:
          "Yes answers divided by eligible completed-session answers; unanswered sessions are excluded from the answer denominator.",
        selection:
          "Authenticated selection accounts are separate from optional, unlinked visitor sessions.",
        visitors:
          "Explicitly opted-in pseudonymous visitor sessions started in the selected UTC window; selected before report end during the same 24-hour session. No account/IP/device linkage. Sessions expire after 24 hours and records are deleted after 31 days. This is session conversion, not unique-person conversion.",
        matching:
          "Server-observed matching attempts only. Offer success is atomic reservation offers / attempts. Acceptance latency is server attempt start to first host acceptance, nearest-rank median/p95; requests without acceptance have no latency sample.",
        retention:
          "First captured base purchase cohorts in the selected UTC window. A repeat is a different captured booking within N days. Only customers with the full N-day observation window ending by report end enter the denominator; refunds do not erase a historical purchase.",
        rebooking:
          "Captured base purchases in the selected window with an earlier captured purchase by the same customer with the same host, divided by all captured base purchases in that window.",
        utilization:
          "Dual participant attendance overlapping declared availability, divided by observed available time. Availability is bounded by the next heartbeat and the 90-second freshness limit; absent history is unmeasured. Attendance outside observed availability is shown separately and never inflates the rate.",
        deliveredContribution:
          "Net platform revenue less recorded processing/video/dispute expenses for completed bookings created in the selected window, posted before report end, divided by that completed-booking count. Missing external cost entries are not estimated.",
      },
      counts: {
        requested: b.requested,
        accepted: counts.accepted,
        paid: counts.paid,
        completed: b.completed,
        failed: b.failed,
        selections: selections.n,
        checkoutStarted: counts.checkout,
        sessionStarted: counts.started,
        pendingNotifications: pending.n,
        consentedVisitorSessions: visitors.visitors,
        visitorSelections: visitors.selected,
      },
      rates: {
        visitorToSelection: ratio(visitors.selected, visitors.visitors),
        matchSuccess: ratio(attempts.offered, attempts.requested),
        matchAcceptance: ratio(attempts.accepted, attempts.requested),
        acceptance: ratio(counts.accepted, b.requested),
        checkout: ratio(counts.paid, counts.checkout),
        paidToSessionStart: ratio(counts.started, counts.paid),
        completion: ratio(b.completed, counts.paid),
        worthIt: ratio(feedback.yes, feedback.answers),
        valueResponse: ratio(feedback.answers, b.completed),
        refunds: ratio(counts.refunded, counts.paid),
        safetyReports: ratio(counts.reported, b.requested),
        rebooking: ratio(rebook.repeated, rebook.total),
      },
      matching: {
        attempts: attempts.requested,
        offered: attempts.offered,
        noMatch: attempts.no_match,
        pending: attempts.pending,
        latencySamples: times.length,
        medianMs: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
      },
      retention: {
        days7: await retention(from, to, 7),
        days30: await retention(from, to, 30),
      },
      hostUtilization: await utilization(from, to),
      visitorCoverage: {
        recordedSince: visitorBegan?.began_at ?? null,
        retainedSince: clock() - VISITOR_RETENTION,
        completeWindow:
          !!visitorBegan &&
          from >= Math.max(clock() - VISITOR_RETENTION, visitorBegan.began_at),
        optInOnly: true,
        identityLinked: false,
      },
      financial: {
        customerNetCents: money.customer_net,
        platformRevenueCents: revenue,
        processingFeesCents: fees,
        videoCostsCents: video,
        disputeLossCents: loss,
        contributionCents: revenue - fees - video - loss,
        grossMerchandiseValueCents: money.gmv,
        tipPrincipalCents: money.tips,
        refundPrincipalCents: money.refunds,
        deliveredContribution: {
          totalCents: deliveredContribution.cents,
          denominator: b.completed,
          centsPerSession: b.completed
            ? deliveredContribution.cents / b.completed
            : null,
        },
      },
      events,
    };
  }
  async function hostQuality(
    actor,
    { from = clock() - 30 * DAY, to = clock() } = {},
  ) {
    await check(actor, ["host"]);
    need(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from < to &&
        to <= clock() + 60000 &&
        to - from <= 366 * DAY,
      "VALIDATION",
      "Choose a reporting window of at most one year.",
      400,
    );
    const counts = await first(
      `SELECT COUNT(*) requested,COALESCE(SUM(status='COMPLETED'),0) completed,
      COALESCE(SUM(status IN ('FAILED_SERVICE','PARTIAL_DELIVERY','SAFETY_ENDED')),0) failed,
      COALESCE(SUM(EXISTS(SELECT 1 FROM mp_booking_events e WHERE e.booking_id=b.id AND e.action='accept')),0) accepted,
      COALESCE(SUM(EXISTS(SELECT 1 FROM mp_booking_events e WHERE e.booking_id=b.id AND e.action='decline')),0) declined
      FROM mp_bookings b WHERE host_id=? AND created_at>=? AND created_at<?`,
      actor.id,
      from,
      to,
    );
    const feedback = await first(
      `SELECT COUNT(r.rating) ratings,AVG(r.rating) average,COUNT(r.worth_it) value_answers,COALESCE(SUM(r.worth_it=1),0) value_yes
      FROM mp_reviews r JOIN mp_bookings b ON b.id=r.booking_id WHERE b.host_id=? AND b.status='COMPLETED' AND b.created_at>=? AND b.created_at<?`,
      actor.id,
      from,
      to,
    );
    return {
      from,
      to,
      counts,
      ratings: { average: feedback.average, denominator: feedback.ratings },
      worthIt: ratio(feedback.value_yes, feedback.value_answers),
      acceptance: ratio(counts.accepted, counts.requested),
      completion: ratio(counts.completed, counts.accepted),
      utilization: await utilization(from, to, actor.id),
      definitions: {
        cohort:
          "Your bookings created in the selected UTC window; current outcomes.",
        ratings:
          "Only eligible completed-session public ratings. Private guest feedback and reports are not exposed.",
        utilization:
          "Observed available heartbeat time and trusted dual attendance only. Unobserved time is explicit.",
      },
    };
  }
  return {
    startVisitor,
    recordVisitor,
    forgetVisitor,
    pruneAnalytics,
    startMatch,
    finishMatch,
    analytics,
    hostQuality,
  };
}
