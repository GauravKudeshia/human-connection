import { activities } from "../activities.mjs";
import { stylesFor } from "../catalog.mjs";
import { fingerprint } from "../fingerprint.mjs";
import { quoteFor as defaultQuoteFor } from "./pricing.mjs";
import { MarketplaceError, requireCondition, text } from "./errors.mjs";

const experiences = ["laugh", "hear", "distract"];
const activeStates = ["REQUESTED", "ACCEPTED", "READY", "LIVE"];
const id = () => crypto.randomUUID();
const requireValue = (condition, message) =>
  requireCondition(condition, "VALIDATION", message, 400);
const uuid = (value) => text(value, 128);
const eligibleSql = `
 FROM mp_host_profiles h
 JOIN mp_users u ON u.id=h.user_id
 JOIN mp_host_verifications v ON v.user_id=h.user_id
 JOIN mp_certifications c ON c.host_id=h.user_id
 JOIN mp_host_presence p ON p.host_id=h.user_id
 WHERE h.status='APPROVED' AND u.status='ACTIVE'
 AND v.status='VERIFIED' AND v.adult_verified=1 AND v.jurisdiction='US' AND v.payout_status='ELIGIBLE'
 AND c.experience=? AND c.status='APPROVED' AND c.expires_at>?
 AND EXISTS(SELECT 1 FROM json_each(h.languages) WHERE value=?)
 AND EXISTS(SELECT 1 FROM json_each(h.formats) WHERE value=?)
 AND p.available=1 AND p.last_seen_at>=? AND p.last_seen_at<=?
 AND h.user_id<>?
 AND NOT EXISTS(SELECT 1 FROM mp_blocks WHERE (owner_id=? AND blocked_id=h.user_id) OR (owner_id=h.user_id AND blocked_id=?))
 AND NOT EXISTS(SELECT 1 FROM mp_host_claims WHERE host_id=h.user_id)`;

// All methods use a D1-compatible connection. HTTP authentication supplies actors.
export function createMarketplace(
  db,
  { clock = Date.now, quoteFor = defaultQuoteFor } = {},
) {
  const authenticatedActors = new WeakSet();
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  const first = (query, ...args) => sql(query, ...args).first();
  const all = async (query, ...args) =>
    (await sql(query, ...args).all()).results;
  function event(actor, subjectId, action, details = {}) {
    return sql(
      "INSERT INTO mp_audit_events VALUES(?,?,?,?,?,?)",
      id(),
      actor?.id || null,
      subjectId,
      action,
      JSON.stringify(details),
      clock(),
    );
  }
  async function authorize(actor, roles = [], stepUp = false) {
    requireCondition(
      actor && authenticatedActors.has(actor),
      "UNAUTHENTICATED",
      "A verified session is required.",
      401,
    );
    const user = await first(
      "SELECT id,status FROM mp_users WHERE id=?",
      actor.id,
    );
    requireCondition(
      user?.status === "ACTIVE",
      "ACCOUNT_UNAVAILABLE",
      "This account is unavailable.",
      403,
    );
    const current = await all(
      "SELECT role FROM mp_user_roles WHERE user_id=?",
      actor.id,
    );
    const assigned = current.map((entry) => entry.role);
    requireCondition(
      !roles.length || roles.some((role) => assigned.includes(role)),
      "FORBIDDEN",
      "This action requires a different permission.",
      403,
    );
    requireCondition(
      !stepUp || actor.stepUp === true,
      "STEP_UP_REQUIRED",
      "A recent multi-factor sign-in is required.",
      403,
    );
    return assigned;
  }
  async function provisionIdentity(identity) {
    requireValue(
      identity &&
        typeof identity.subject === "string" &&
        identity.subject.length > 0,
      "A verified identity is required.",
    );
    const proposed = id();
    const now = clock();
    await db.batch([
      sql(
        "INSERT INTO mp_users(id,provider_subject,display_name,created_at) VALUES(?,?,?,?) ON CONFLICT(provider_subject) DO NOTHING",
        proposed,
        identity.subject,
        text(identity.displayName || "Member", 100),
        now,
      ),
      sql(
        "INSERT OR IGNORE INTO mp_user_roles(user_id,role) SELECT id,'customer' FROM mp_users WHERE provider_subject=?",
        identity.subject,
      ),
    ]);
    const user = await first(
      "SELECT id,status FROM mp_users WHERE provider_subject=?",
      identity.subject,
    );
    requireCondition(
      user.status === "ACTIVE",
      "ACCOUNT_UNAVAILABLE",
      "This account is unavailable.",
      403,
    );
    const roles = await all(
      "SELECT role FROM mp_user_roles WHERE user_id=?",
      user.id,
    );
    const actor = Object.freeze({
      id: user.id,
      roles: roles.map((entry) => entry.role),
      stepUp: identity.stepUp === true,
    });
    authenticatedActors.add(actor);
    return actor;
  }
  async function expire() {
    const now = clock();
    await db.batch([
      sql(
        `INSERT INTO mp_booking_events SELECT lower(hex(randomblob(16))),id,NULL,'expired',
        CASE WHEN status='LIVE' THEN 'FAILED_SERVICE' ELSE 'EXPIRED' END,?
        FROM mp_bookings WHERE status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND expires_at<=?`,
        now,
        now,
      ),
      sql(
        `INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at)
        SELECT lower(hex(randomblob(16))),b.id,p.id,'Reservation or session deadline passed. Review required.','OPEN',?,?
        FROM mp_bookings b JOIN mp_payments p ON p.booking_id=b.id
        WHERE b.status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND b.expires_at<=? AND p.status='CAPTURED'`,
        now,
        now,
        now,
      ),
      sql(
        `UPDATE mp_bookings SET status=CASE WHEN status='LIVE' THEN 'FAILED_SERVICE' ELSE 'EXPIRED' END,updated_at=?
        WHERE status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND expires_at<=?`,
        now,
        now,
      ),
      sql(
        `DELETE FROM mp_host_claims WHERE expires_at<=? OR booking_id IN
        (SELECT id FROM mp_bookings WHERE status NOT IN ('REQUESTED','ACCEPTED','READY','LIVE'))`,
        now,
      ),
    ]);
  }
  async function booking(actor, bookingId) {
    const row = await first(
      "SELECT * FROM mp_bookings WHERE id=?",
      uuid(bookingId),
    );
    requireCondition(
      row && [row.customer_id, row.host_id].includes(actor.id),
      "NOT_FOUND",
      "Session not found.",
      404,
    );
    return row;
  }
  function eligibleArgs(actor, preferences) {
    const now = clock();
    return [
      preferences.experience,
      now,
      preferences.language,
      preferences.format,
      now - 45000,
      now,
      actor.id,
      actor.id,
      actor.id,
    ];
  }
  function preferences(value) {
    requireValue(
      experiences.includes(value.experience) &&
        [15, 30].includes(value.duration) &&
        ["audio", "video"].includes(value.format) &&
        ["English", "Spanish"].includes(value.language),
      "Choose an experience, duration, format and supported language.",
    );
    requireValue(
      !value.style ||
        stylesFor(value.experience).some((style) => style.id === value.style),
      "Choose a compatible style.",
    );
    return {
      experience: value.experience,
      duration: value.duration,
      format: value.format,
      language: value.language,
      style: value.style || null,
    };
  }
  async function reserve(actor, payload, key) {
    await authorize(actor, ["customer"]);
    const choice = preferences(payload);
    const digest = fingerprint(
      JSON.stringify({ ...choice, hostId: payload.hostId || null }),
    );
    const replay = await first(
      "SELECT * FROM mp_bookings WHERE customer_id=? AND request_key=?",
      actor.id,
      key,
    );
    if (replay) {
      requireCondition(
        replay.fingerprint === digest,
        "KEY_REUSED",
        "This request key belongs to different choices.",
      );
      return {
        booking: { ...replay, quote: JSON.parse(replay.quote) },
        replayed: true,
      };
    }
    let candidates = await all(
      "SELECT h.user_id,h.styles" + eligibleSql,
      ...eligibleArgs(actor, choice),
    );
    if (payload.hostId)
      candidates = candidates.filter(
        (entry) => entry.user_id === payload.hostId,
      );
    // Deterministic assignment counts are persisted bookings, never client counters.
    const counts = await all(
      "SELECT host_id,COUNT(*) count,MAX(created_at) last FROM mp_bookings GROUP BY host_id",
    );
    const countFor = (hostId) =>
      counts.find((entry) => entry.host_id === hostId) || { count: 0, last: 0 };
    candidates.sort(
      (a, b) =>
        Number(JSON.parse(b.styles).includes(choice.style)) -
          Number(JSON.parse(a.styles).includes(choice.style)) ||
        countFor(a.user_id).count - countFor(b.user_id).count ||
        countFor(a.user_id).last - countFor(b.user_id).last ||
        a.user_id.localeCompare(b.user_id),
    );
    requireCondition(
      candidates.length,
      "NO_MATCH",
      "No eligible host is available for those choices.",
    );
    const hostId = candidates[0].user_id;
    const bookingId = id();
    const now = clock();
    const quote = quoteFor({ ...choice, now });
    const expiresAt = now + 30000;
    try {
      await db.batch([
        sql(
          `INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'REQUESTED',?,?,?` +
            eligibleSql +
            " AND h.user_id=? ON CONFLICT(customer_id,request_key) DO NOTHING",
          bookingId,
          actor.id,
          hostId,
          key,
          digest,
          choice.experience,
          choice.duration,
          choice.format,
          choice.language,
          JSON.stringify(quote),
          quote.totalCents,
          quote.currency,
          expiresAt,
          now,
          now,
          ...eligibleArgs(actor, choice),
          hostId,
        ),
        sql(
          "INSERT INTO mp_host_claims SELECT host_id,customer_id,id,expires_at FROM mp_bookings WHERE id=?",
          bookingId,
        ),
        sql(
          "INSERT INTO mp_booking_events SELECT ?,id,customer_id,'requested',status,? FROM mp_bookings WHERE id=?",
          id(),
          now,
          bookingId,
        ),
        sql(
          "INSERT INTO mp_notifications(id,user_id,booking_id,kind,available_at,created_at) SELECT ?,host_id,id,'host_request',?,? FROM mp_bookings WHERE id=?",
          id(),
          now,
          now,
          bookingId,
        ),
      ]);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message))
        throw new MarketplaceError(
          "HOST_RESERVED",
          "That host or customer already has an active reservation.",
        );
      throw error;
    }
    const stored = await first(
      "SELECT * FROM mp_bookings WHERE customer_id=? AND request_key=?",
      actor.id,
      key,
    );
    requireCondition(
      stored,
      "HOST_RESERVED",
      "Host availability changed. Please search again.",
    );
    requireCondition(
      stored.fingerprint === digest,
      "KEY_REUSED",
      "This request key belongs to different choices.",
    );
    return { booking: { ...stored, quote: JSON.parse(stored.quote) } };
  }
  async function transition(actor, payload, action) {
    const b = await booking(actor, payload.bookingId);
    const hostAction = ["accept", "decline"].includes(action);
    requireCondition(
      !hostAction || b.host_id === actor.id,
      "FORBIDDEN",
      "Only the requested host can respond.",
      403,
    );
    if (hostAction) await authorize(actor, ["host"]);
    const allowed =
      action === "cancel" ? ["REQUESTED", "ACCEPTED", "READY"] : ["REQUESTED"];
    requireCondition(
      allowed.includes(b.status),
      "INVALID_STATE",
      "This session cannot make that transition.",
    );
    const status = {
      accept: "ACCEPTED",
      decline: "DECLINED",
      cancel: "CANCELLED",
    }[action];
    const now = clock();
    const quote =
      action === "accept"
        ? quoteFor({
            experience: b.experience,
            duration: b.duration,
            format: b.format,
            language: b.language,
            style: JSON.parse(b.quote).style,
            now,
          })
        : JSON.parse(b.quote);
    const expiry = action === "accept" ? now + 180000 : now;
    const transitionId = id();
    const guard = "EXISTS(SELECT 1 FROM mp_booking_events WHERE id=?)";
    const hostCheck =
      action === "accept"
        ? " AND EXISTS(SELECT h.user_id" +
          eligibleSql.replace(
            " AND NOT EXISTS(SELECT 1 FROM mp_host_claims WHERE host_id=h.user_id)",
            "",
          ) +
          " AND h.user_id=?)"
        : "";
    const hostArgs =
      action === "accept"
        ? [...eligibleArgs({ id: b.customer_id }, b), b.host_id]
        : [];
    const changes = [
      sql(
        "INSERT INTO mp_booking_events SELECT ?,id,?,?,?,? FROM mp_bookings WHERE id=? AND status=? AND expires_at>?" +
          hostCheck,
        transitionId,
        actor.id,
        action,
        status,
        now,
        b.id,
        b.status,
        now,
        ...hostArgs,
      ),
      sql(
        "UPDATE mp_bookings SET status=?,expires_at=?,quote=?,amount_cents=?,updated_at=? WHERE id=? AND " +
          guard,
        status,
        expiry,
        JSON.stringify(quote),
        quote.totalCents,
        now,
        b.id,
        transitionId,
      ),
    ];
    if (action === "accept")
      changes.push(
        sql(
          "UPDATE mp_host_claims SET expires_at=? WHERE booking_id=? AND " +
            guard,
          expiry,
          b.id,
          transitionId,
        ),
      );
    else {
      changes.push(
        sql(
          "DELETE FROM mp_host_claims WHERE booking_id=? AND " + guard,
          b.id,
          transitionId,
        ),
      );
      changes.push(
        sql(
          `INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at)
        SELECT ?,booking_id,id,'Cancelled after payment. Review required.','OPEN',?,? FROM mp_payments WHERE booking_id=? AND status='CAPTURED' AND ` +
            guard,
          id(),
          now,
          now,
          b.id,
          transitionId,
        ),
      );
    }
    changes.push(
      sql(
        "INSERT INTO mp_notifications(id,user_id,booking_id,kind,available_at,created_at) SELECT ?,?,?,?,?,? WHERE " +
          guard,
        id(),
        b.customer_id,
        b.id,
        action,
        now,
        now,
        transitionId,
      ),
    );
    const result = await db.batch(changes);
    requireCondition(
      result[0].meta.changes === 1,
      "CONCURRENT_UPDATE",
      "This session changed. Refresh before retrying.",
    );
    return { booking: await booking(actor, b.id) };
  }
  async function submitHost(actor, payload) {
    const languages = payload.languages,
      formats = payload.formats,
      styles = payload.styles || [];
    requireValue(
      payload.adult === true &&
        payload.policyVersion === "beta-2026-11" &&
        payload.trainingVersion === "beta-2026-11",
      "Adult eligibility, policies and training acknowledgements are required.",
    );
    requireValue(
      Array.isArray(languages) &&
        languages.length &&
        languages.length <= 2 &&
        languages.every((language) =>
          ["English", "Spanish"].includes(language),
        ),
      "Choose supported languages.",
    );
    requireValue(
      Array.isArray(formats) &&
        formats.length &&
        formats.length <= 2 &&
        formats.every((format) => ["audio", "video"].includes(format)),
      "Choose supported formats.",
    );
    requireValue(
      Array.isArray(styles) &&
        styles.length <= 9 &&
        styles.every((style) =>
          experiences.some((experience) =>
            stylesFor(experience).some((entry) => entry.id === style),
          ),
        ),
      "Choose supported styles.",
    );
    const current = await first(
      "SELECT status FROM mp_host_profiles WHERE user_id=?",
      actor.id,
    );
    requireCondition(
      !current || ["DRAFT", "REJECTED"].includes(current.status),
      "INVALID_STATE",
      "This application is already under review or approved.",
    );
    await db.batch([
      sql(
        `INSERT INTO mp_host_profiles(user_id,display_name,biography,languages,formats,styles,status,policy_version,training_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'SUBMITTED',?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,
        biography=excluded.biography,languages=excluded.languages,formats=excluded.formats,styles=excluded.styles,
        status='SUBMITTED',policy_version=excluded.policy_version,training_version=excluded.training_version,updated_at=excluded.updated_at`,
        actor.id,
        text(payload.displayName, 100),
        text(payload.biography, 1000),
        JSON.stringify(languages),
        JSON.stringify(formats),
        JSON.stringify(styles),
        payload.policyVersion,
        payload.trainingVersion,
        clock(),
        clock(),
      ),
      event(actor, actor.id, "host-submitted"),
    ]);
    return { status: "SUBMITTED" };
  }
  async function reviewHost(actor, payload) {
    await authorize(actor, ["host_reviewer", "admin"], true);
    requireValue(
      [
        "IDENTITY_PENDING",
        "REVIEW_PENDING",
        "APPROVED",
        "REJECTED",
        "SUSPENDED",
      ].includes(payload.status),
      "Choose a review status.",
    );
    const hostId = uuid(payload.hostId);
    const reason = text(payload.reason);
    const current = await first(
      "SELECT * FROM mp_host_profiles WHERE user_id=?",
      hostId,
    );
    requireCondition(current, "NOT_FOUND", "Application not found.", 404);
    const verification = await first(
      "SELECT * FROM mp_host_verifications WHERE user_id=?",
      hostId,
    );
    requireCondition(
      payload.status !== "APPROVED" ||
        (verification?.status === "VERIFIED" &&
          verification.adult_verified === 1 &&
          verification.jurisdiction === "US" &&
          verification.payout_status === "ELIGIBLE"),
      "VERIFICATION_REQUIRED",
      "Provider verification and payout eligibility are required before approval.",
    );
    const statements = [
      sql(
        "UPDATE mp_host_profiles SET status=?,review_reason=?,updated_at=? WHERE user_id=?",
        payload.status,
        reason,
        clock(),
        hostId,
      ),
      event(actor, hostId, "host-reviewed", { status: payload.status, reason }),
    ];
    if (payload.status === "APPROVED")
      statements.push(
        sql("INSERT OR IGNORE INTO mp_user_roles VALUES(?,'host')", hostId),
      );
    if (payload.status === "SUSPENDED")
      statements.push(
        sql("UPDATE mp_host_presence SET available=0 WHERE host_id=?", hostId),
      );
    await db.batch(statements);
    return { status: payload.status };
  }
  async function certify(actor, payload) {
    await authorize(actor, ["host_reviewer", "admin"], true);
    const hostId = uuid(payload.hostId);
    requireValue(
      experiences.includes(payload.experience) &&
        ["APPROVED", "REVOKED"].includes(payload.status),
      "Choose an experience and certification status.",
    );
    requireValue(
      Number.isSafeInteger(payload.expiresAt) &&
        payload.expiresAt > clock() &&
        payload.expiresAt <= clock() + 366 * 86400000,
      "Choose a certification expiry within one year.",
    );
    const host = await first(
      "SELECT * FROM mp_host_profiles WHERE user_id=?",
      hostId,
    );
    requireCondition(
      host?.status === "APPROVED",
      "INVALID_STATE",
      "Approve the host profile before certifying an experience.",
    );
    await db.batch([
      sql(
        `INSERT INTO mp_certifications VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(host_id,experience) DO UPDATE SET status=excluded.status,
        rubric=excluded.rubric,reviewer_id=excluded.reviewer_id,version=mp_certifications.version+1,
        reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at`,
        hostId,
        payload.experience,
        payload.status,
        text(payload.rubric),
        actor.id,
        clock(),
        payload.expiresAt,
      ),
      event(actor, hostId, "certification-reviewed", {
        experience: payload.experience,
        status: payload.status,
      }),
    ]);
    return { status: payload.status };
  }
  async function activity(actor, payload) {
    const b = await booking(actor, payload.bookingId);
    requireCondition(
      b.status === "LIVE",
      "INVALID_STATE",
      "Activities require an active session.",
    );
    requireValue(
      Number.isSafeInteger(payload.revision) && payload.revision >= 0,
      "A current activity revision is required.",
    );
    requireValue(
      ["select", "advance", "reveal", "complete", "clear"].includes(
        payload.operation,
      ),
      "Choose an activity operation.",
    );
    const selected = payload.activityId
      ? activities.find(
          (entry) =>
            entry.id === payload.activityId &&
            entry.experience === b.experience,
        )
      : null;
    requireValue(
      payload.operation !== "select" || selected,
      "Choose a compatible activity.",
    );
    await sql(
      "INSERT OR IGNORE INTO mp_activity_sessions(booking_id,updated_at) VALUES(?,?)",
      b.id,
      clock(),
    ).run();
    const current = await first(
      "SELECT * FROM mp_activity_sessions WHERE booking_id=?",
      b.id,
    );
    requireCondition(
      current.revision === payload.revision,
      "STALE_REVISION",
      "The activity changed. Refresh before trying again.",
    );
    requireCondition(
      payload.operation !== "reveal" ||
        activities.find((entry) => entry.id === current.activity_id)?.answer,
      "INVALID_STATE",
      "This activity has no answer to reveal.",
    );
    requireCondition(
      ["select", "clear"].includes(payload.operation) || current.activity_id,
      "INVALID_STATE",
      "Choose an activity first.",
    );
    const next = {
      id:
        payload.operation === "select"
          ? selected.id
          : payload.operation === "clear"
            ? null
            : current.activity_id,
      prompt:
        payload.operation === "advance"
          ? current.prompt_index + 1
          : payload.operation === "select" || payload.operation === "clear"
            ? 0
            : current.prompt_index,
      reveal:
        payload.operation === "reveal"
          ? 1
          : payload.operation === "advance" ||
              payload.operation === "select" ||
              payload.operation === "clear"
            ? 0
            : current.answer_revealed,
      completed:
        payload.operation === "complete"
          ? 1
          : payload.operation === "select" || payload.operation === "clear"
            ? 0
            : current.completed,
    };
    const result = await db.batch([
      sql(
        "UPDATE mp_activity_sessions SET activity_id=?,revision=revision+1,prompt_index=?,answer_revealed=?,completed=?,updated_by=?,updated_at=? WHERE booking_id=? AND revision=?",
        next.id,
        next.prompt,
        next.reveal,
        next.completed,
        actor.id,
        clock(),
        b.id,
        payload.revision,
      ),
      sql(
        `INSERT INTO mp_activity_events SELECT ?,booking_id,revision,?,?,activity_id,? FROM mp_activity_sessions
        WHERE booking_id=? AND revision=? AND updated_by=?`,
        id(),
        actor.id,
        payload.operation,
        clock(),
        b.id,
        payload.revision + 1,
        actor.id,
      ),
    ]);
    requireCondition(
      result[0].meta.changes === 1,
      "STALE_REVISION",
      "The activity changed. Refresh before trying again.",
    );
    return {
      activity: await first(
        "SELECT * FROM mp_activity_sessions WHERE booking_id=?",
        b.id,
      ),
    };
  }
  async function report(actor, payload, key) {
    const b = await booking(actor, payload.bookingId);
    const reportedId = b.customer_id === actor.id ? b.host_id : b.customer_id;
    requireValue(
      ["conduct", "harassment", "scam", "boundaries", "other"].includes(
        payload.category,
      ),
      "Choose a report category.",
    );
    const narrative = text(payload.reason);
    const digest = fingerprint(
      JSON.stringify({
        bookingId: b.id,
        category: payload.category,
        urgent: payload.urgent === true,
        narrative,
      }),
    );
    const previous = await first(
      "SELECT id,fingerprint FROM mp_safety_reports WHERE reporter_id=? AND request_key=?",
      actor.id,
      key,
    );
    if (previous) {
      requireCondition(
        previous.fingerprint === digest,
        "KEY_REUSED",
        "This request key belongs to a different report.",
      );
      return { caseId: previous.id, replayed: true };
    }
    const reportId = id();
    const urgent = payload.urgent === true;
    const guard = "EXISTS(SELECT 1 FROM mp_safety_reports WHERE id=?)";
    const statements = [
      sql(
        "INSERT INTO mp_safety_reports(id,reporter_id,reported_id,booking_id,category,severity,narrative,status,created_at,updated_at,request_key,fingerprint) VALUES(?,?,?,?,?,?,?,'OPEN',?,?,?,?) ON CONFLICT(reporter_id,request_key) DO NOTHING",
        reportId,
        actor.id,
        reportedId,
        b.id,
        payload.category,
        urgent ? "URGENT" : "STANDARD",
        narrative,
        clock(),
        clock(),
        key,
        digest,
      ),
      sql(
        "INSERT INTO mp_audit_events SELECT ?,?,?,?,'{}',? WHERE " + guard,
        id(),
        actor.id,
        reportId,
        "report-submitted",
        clock(),
        reportId,
      ),
    ];
    if (urgent && activeStates.includes(b.status))
      statements.push(
        sql(
          "UPDATE mp_bookings SET status='SAFETY_ENDED',updated_at=? WHERE id=? AND status IN ('REQUESTED','ACCEPTED','READY','LIVE') AND " +
            guard,
          clock(),
          b.id,
          reportId,
        ),
        sql(
          "DELETE FROM mp_host_claims WHERE booking_id=? AND " + guard,
          b.id,
          reportId,
        ),
        sql(
          `INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at)
        SELECT ?,booking_id,id,'Safety termination. Review required.','OPEN',?,? FROM mp_payments WHERE booking_id=? AND status='CAPTURED' AND ` +
            guard,
          id(),
          clock(),
          clock(),
          b.id,
          reportId,
        ),
        sql(
          "INSERT INTO mp_booking_events SELECT ?,id,?,'safety-ended','SAFETY_ENDED',? FROM mp_bookings WHERE id=? AND " +
            guard,
          id(),
          actor.id,
          clock(),
          b.id,
          reportId,
        ),
      );
    await db.batch(statements);
    const stored = await first(
      "SELECT id,fingerprint FROM mp_safety_reports WHERE reporter_id=? AND request_key=?",
      actor.id,
      key,
    );
    requireCondition(
      stored.fingerprint === digest,
      "KEY_REUSED",
      "This request key belongs to a different report.",
    );
    return { caseId: stored.id };
  }
  async function act(actor, action, payload = {}, requestKey) {
    await authorize(actor);
    requireValue(
      payload && typeof payload === "object" && !Array.isArray(payload),
      "A request object is required.",
    );
    await expire();
    const window = Math.floor(clock() / 60000);
    const limit = await sql(
      "INSERT INTO mp_rate_limits VALUES(?,?,1) ON CONFLICT(user_id,window) DO UPDATE SET count=count+1 RETURNING count",
      actor.id,
      window,
    ).first();
    requireCondition(
      limit.count <= 120,
      "RATE_LIMITED",
      "Too many requests. Try again shortly.",
      429,
    );
    switch (action) {
      case "reserve":
        return reserve(actor, payload, text(requestKey, 128));
      case "accept":
      case "decline":
      case "cancel":
        return transition(actor, payload, action);
      case "host-submit":
        return submitHost(actor, payload);
      case "host-review":
        return reviewHost(actor, payload);
      case "certify":
        return certify(actor, payload);
      case "heartbeat": {
        await authorize(actor, ["host"]);
        const host = await first(
          "SELECT status FROM mp_host_profiles WHERE user_id=?",
          actor.id,
        );
        requireCondition(
          host?.status === "APPROVED",
          "FORBIDDEN",
          "Host approval is required.",
          403,
        );
        requireValue(
          typeof payload.available === "boolean",
          "Choose an availability state.",
        );
        await sql(
          "INSERT INTO mp_host_presence VALUES(?,?,?) ON CONFLICT(host_id) DO UPDATE SET available=excluded.available,last_seen_at=excluded.last_seen_at",
          actor.id,
          Number(payload.available),
          clock(),
        ).run();
        return { lastSeenAt: clock() };
      }
      case "favourite": {
        const hostId = uuid(payload.hostId);
        requireValue(
          typeof payload.saved === "boolean" && hostId !== actor.id,
          "Choose a valid host and saved state.",
        );
        const host = await first(
          "SELECT user_id FROM mp_host_profiles WHERE user_id=? AND status='APPROVED'",
          hostId,
        );
        requireCondition(host, "NOT_FOUND", "Host not found.", 404);
        const blocked = await first(
          "SELECT 1 FROM mp_blocks WHERE (owner_id=? AND blocked_id=?) OR (owner_id=? AND blocked_id=?)",
          actor.id,
          hostId,
          hostId,
          actor.id,
        );
        requireCondition(!blocked, "BLOCKED", "This host is blocked.");
        await (
          payload.saved
            ? sql(
                "INSERT OR IGNORE INTO mp_favourites VALUES(?,?,?)",
                actor.id,
                hostId,
                clock(),
              )
            : sql(
                "DELETE FROM mp_favourites WHERE customer_id=? AND host_id=?",
                actor.id,
                hostId,
              )
        ).run();
        return { saved: payload.saved };
      }
      case "block": {
        const blockedId = uuid(payload.userId);
        requireValue(blockedId !== actor.id, "Choose a different account.");
        // A relationship is required so arbitrary public IDs cannot be probed through block requests.
        const related = await first(
          "SELECT id FROM mp_bookings WHERE (customer_id=? AND host_id=?) OR (host_id=? AND customer_id=?)",
          actor.id,
          blockedId,
          actor.id,
          blockedId,
        );
        requireCondition(
          related,
          "NOT_FOUND",
          "Related account not found.",
          404,
        );
        await db.batch([
          sql(
            "INSERT OR IGNORE INTO mp_blocks VALUES(?,?,?)",
            actor.id,
            blockedId,
            clock(),
          ),
          sql(
            "DELETE FROM mp_favourites WHERE customer_id=? AND host_id=?",
            actor.id,
            blockedId,
          ),
          event(actor, blockedId, "blocked"),
        ]);
        return { blocked: true };
      }
      case "report":
        return report(actor, payload, text(requestKey, 128));
      case "case-decision": {
        await authorize(actor, ["safety", "admin"], true);
        requireValue(
          ["ASSIGNED", "ESCALATED", "CLOSED"].includes(payload.status),
          "Choose a case decision.",
        );
        const caseId = uuid(payload.caseId);
        const current = await first(
          "SELECT * FROM mp_safety_reports WHERE id=?",
          caseId,
        );
        requireCondition(
          current && current.status !== "CLOSED",
          "INVALID_STATE",
          "This case is unavailable.",
        );
        requireCondition(
          current.status !== payload.status,
          "INVALID_STATE",
          "Choose a different case status.",
        );
        const reason = text(payload.reason);
        const decisionId = id();
        const result = await db.batch([
          sql(
            "INSERT INTO mp_case_events SELECT ?,id,?,?,?,? FROM mp_safety_reports WHERE id=? AND status=?",
            decisionId,
            actor.id,
            payload.status,
            reason,
            clock(),
            caseId,
            current.status,
          ),
          sql(
            "UPDATE mp_safety_reports SET status=?,assigned_to=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_case_events WHERE id=?)",
            payload.status,
            actor.id,
            clock(),
            caseId,
            decisionId,
          ),
        ]);
        requireCondition(
          result[0].meta.changes === 1,
          "CONCURRENT_UPDATE",
          "This case changed. Refresh before retrying.",
        );
        return { status: payload.status };
      }
      case "activity":
        return activity(actor, payload);
      case "review": {
        const b = await booking(actor, payload.bookingId);
        requireCondition(
          b.customer_id === actor.id && b.status === "COMPLETED",
          "INVALID_STATE",
          "Feedback requires your completed session.",
        );
        requireValue(
          Number.isInteger(payload.rating) &&
            payload.rating >= 1 &&
            payload.rating <= 5 &&
            (payload.worthIt === undefined ||
              typeof payload.worthIt === "boolean"),
          "Choose a rating and value response.",
        );
        const feedback = payload.privateFeedback
          ? text(payload.privateFeedback, 1000)
          : null;
        await sql(
          "INSERT INTO mp_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET rating=excluded.rating,worth_it=excluded.worth_it,private_feedback=excluded.private_feedback",
          b.id,
          actor.id,
          payload.rating,
          payload.worthIt === undefined ? null : Number(payload.worthIt),
          feedback,
          clock(),
        ).run();
        return { saved: true };
      }
      case "refund-request": {
        const b = await booking(actor, payload.bookingId);
        requireCondition(
          b.customer_id === actor.id && !activeStates.includes(b.status),
          "INVALID_STATE",
          "End the session before requesting a refund review.",
        );
        const payment = await first(
          "SELECT id FROM mp_payments WHERE booking_id=? AND status='CAPTURED'",
          b.id,
        );
        requireCondition(
          payment,
          "INVALID_STATE",
          "There is no captured payment to review.",
        );
        await sql(
          "INSERT OR IGNORE INTO mp_refunds(id,booking_id,payment_id,reason,status,created_at,updated_at) VALUES(?,?,?,?,'OPEN',?,?)",
          id(),
          b.id,
          payment.id,
          text(payload.reason),
          clock(),
          clock(),
        ).run();
        return { requested: true };
      }
      case "refund-decision": {
        await authorize(actor, ["finance", "admin"], true);
        requireValue(
          ["APPROVED", "REJECTED"].includes(payload.status),
          "Choose a refund review decision.",
        );
        const refundId = uuid(payload.refundId),
          reason = text(payload.reason);
        const decisionId = id();
        const result = await db.batch([
          sql(
            "INSERT INTO mp_audit_events SELECT ?,?,?,?, ?,? FROM mp_refunds WHERE id=? AND status='OPEN'",
            decisionId,
            actor.id,
            refundId,
            "refund-decision",
            JSON.stringify({ status: payload.status, reason }),
            clock(),
            refundId,
          ),
          sql(
            "UPDATE mp_refunds SET status=?,reviewer_id=?,resolution=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
            payload.status,
            actor.id,
            reason,
            clock(),
            refundId,
            decisionId,
          ),
        ]);
        requireCondition(
          result[0].meta.changes === 1,
          "INVALID_STATE",
          "This refund review is no longer open.",
        );
        return {
          status: payload.status,
          providerRefundPending: payload.status === "APPROVED",
        };
      }
      default:
        throw new MarketplaceError(
          "NOT_FOUND",
          "This staging operation is unavailable.",
          404,
        );
    }
  }
  async function read(actor, resource, recordId, filter = {}) {
    await authorize(actor);
    await expire();
    switch (resource) {
      case "me":
        return {
          id: actor.id,
          roles: await authorize(actor),
          mode: "staging",
          livePaymentsEnabled: false,
          liveCallsEnabled: false,
        };
      case "bookings":
        return all(
          "SELECT id,customer_id,host_id,status,experience,duration,format,language,amount_cents,currency,created_at FROM mp_bookings WHERE customer_id=? OR host_id=? ORDER BY created_at DESC LIMIT 100",
          actor.id,
          actor.id,
        );
      case "booking": {
        const b = await booking(actor, recordId);
        return { ...b, quote: JSON.parse(b.quote) };
      }
      case "hosts": {
        const choice = preferences(filter);
        return all(
          "SELECT h.user_id,h.display_name,h.biography,h.languages,h.formats,h.styles" +
            eligibleSql +
            " ORDER BY h.user_id LIMIT 100",
          ...eligibleArgs(actor, choice),
        );
      }
      case "application":
        return first(
          "SELECT * FROM mp_host_profiles WHERE user_id=?",
          actor.id,
        );
      case "applications":
        await authorize(actor, ["host_reviewer", "admin"], true);
        return all(
          "SELECT * FROM mp_host_profiles ORDER BY created_at LIMIT 100",
        );
      case "safety":
        await authorize(actor, ["safety", "admin"], true);
        return all(
          "SELECT * FROM mp_safety_reports ORDER BY CASE severity WHEN 'URGENT' THEN 0 ELSE 1 END,created_at LIMIT 100",
        );
      case "my-reports":
        return all(
          "SELECT id,category,severity,status,created_at FROM mp_safety_reports WHERE reporter_id=? ORDER BY created_at DESC LIMIT 100",
          actor.id,
        );
      case "refunds":
        await authorize(actor, ["finance", "admin"], true);
        return all("SELECT * FROM mp_refunds ORDER BY created_at LIMIT 100");
      case "activity": {
        await booking(actor, recordId);
        return first(
          "SELECT * FROM mp_activity_sessions WHERE booking_id=?",
          recordId,
        );
      }
      case "notifications":
        return all(
          "SELECT id,booking_id,kind,status,created_at FROM mp_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
          actor.id,
        );
      case "analytics": {
        await authorize(actor, ["admin"], true);
        const summary = await first(
          "SELECT COUNT(*) requested,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed FROM mp_bookings",
        );
        const worth = await first(
          "SELECT COUNT(worth_it) responses,SUM(CASE WHEN worth_it=1 THEN 1 ELSE 0 END) yes FROM mp_reviews",
        );
        return {
          mode: "staging",
          requested: summary.requested,
          completed: summary.completed || 0,
          worthIt: { yes: worth.yes || 0, responses: worth.responses },
        };
      }
      default:
        throw new MarketplaceError("NOT_FOUND", "Resource not found.", 404);
    }
  }
  return { provisionIdentity, authorize, act, read, expire };
}
