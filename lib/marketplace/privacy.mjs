import { requireCondition as need, text } from "./errors.mjs";

const DAY = 86400000;
const durationFields = [
  "deletionDelayMs",
  "financialRetentionMs",
  "safetyRetentionMs",
  "operationalRetentionMs",
  "telemetryRetentionMs",
  "authenticationRetentionMs",
];
const token = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const digest = async (value) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("base64url");
function validPolicy(value) {
  return (
    value?.approved === true &&
    typeof value.version === "string" &&
    /^[A-Za-z0-9._-]{1,100}$/.test(value.version) &&
    durationFields.every(
      (field) =>
        Number.isSafeInteger(value[field]) &&
        value[field] >= 0 &&
        value[field] <= 100 * 366 * DAY,
    )
  );
}
function policyCopy(value) {
  return {
    approved: true,
    version: value.version,
    ...Object.fromEntries(durationFields.map((field) => [field, value[field]])),
  };
}
/** No retention duration is a legal default. All values require a reviewed policy. */
export function privacyPolicyFromConfig(config = {}) {
  const mapping = {
    deletionDelayMs: "DELETION_DELAY",
    financialRetentionMs: "FINANCIAL_RETENTION",
    safetyRetentionMs: "SAFETY_RETENTION",
    operationalRetentionMs: "OPERATIONAL_RETENTION",
    telemetryRetentionMs: "TELEMETRY_RETENTION",
    authenticationRetentionMs: "AUTHENTICATION_RETENTION",
  };
  const policy = {
    approved: config.MARKETPLACE_PRIVACY_PURGE_ENABLED === "true",
    version: config.MARKETPLACE_PRIVACY_REVIEWED_VERSION,
  };
  for (const [field, name] of Object.entries(mapping)) {
    const value = config["MARKETPLACE_PRIVACY_" + name + "_DAYS"];
    policy[field] =
      typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
        ? Number(value) * DAY
        : NaN;
  }
  return validPolicy(policy) ? policyCopy(policy) : null;
}
/** Called before provisioning so a purged identity cannot silently recreate its account. */
export async function assertIdentityAvailable(db, subject) {
  need(
    typeof subject === "string" && subject.length > 0 && subject.length <= 255,
    "UNAUTHENTICATED",
    "A verified identity is required.",
    401,
  );
  const subjectHash = await digest(subject);
  const blocked = await db
    .prepare("SELECT 1 FROM mp_privacy_subject_blocks WHERE subject_hash=?")
    .bind(subjectHash)
    .first();
  need(!blocked, "ACCOUNT_UNAVAILABLE", "This account is unavailable.", 403);
  return subjectHash;
}

/**
 * Closing access is immediate. Erasure needs explicit reviewed retention configuration.
 * Financial journals, policy records and state-transition evidence remain pseudonymized.
 */
/** @param {any} db @param {{authorize?:any,clock?:()=>number,bucket?:any,policy?:any,endSession?:any}} [options] */
export function createPrivacy(
  db,
  { authorize, clock = Date.now, bucket, policy, endSession } = {},
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
  function event(requestId, actorId, action, details = {}) {
    return sql(
      "INSERT INTO mp_privacy_events VALUES(?,?,?,?,?,?)",
      crypto.randomUUID(),
      requestId,
      actorId || null,
      action,
      JSON.stringify(details),
      clock(),
    );
  }
  const publicStatus = (row) => ({
    requestId: row.id,
    status: row.status,
    requestedAt: row.requested_at,
    eligibleAt: row.eligible_at,
    completedAt: row.completed_at,
    policyVersion: row.policy_version,
    waiting: row.wait_reason !== null,
    preservedEvidence:
      "Financial, policy, audit and safety evidence may be retained under the reviewed policy. Provider-side erasure is a separate operation.",
  });
  async function request(actor, payload = {}, key, attempt = 0) {
    need(
      payload.confirm === true,
      "CONFIRMATION_REQUIRED",
      "Confirm that account access will close immediately.",
      400,
    );
    const requestKey = text(key, 128);
    // Authorization still checks actor provenance before returning any closed-account replay.
    try {
      await check(actor);
    } catch (error) {
      if (error.code !== "ACCOUNT_UNAVAILABLE") throw error;
      const replay = await first(
        "SELECT * FROM mp_privacy_deletions WHERE user_id=? AND request_key=?",
        actor.id,
        requestKey,
      );
      need(replay, "ACCOUNT_UNAVAILABLE", "This account is unavailable.", 403);
      return { ...publicStatus(replay), accessClosed: true, replayed: true };
    }
    const existing = await first(
      "SELECT * FROM mp_privacy_deletions WHERE user_id=?",
      actor.id,
    );
    if (existing) {
      need(
        existing.request_key === requestKey,
        "DELETION_ALREADY_REQUESTED",
        "Account closure has already been requested.",
      );
      return { ...publicStatus(existing), accessClosed: true, replayed: true };
    }
    const user = await first("SELECT * FROM mp_users WHERE id=?", actor.id);
    const roles = await all(
      "SELECT role FROM mp_user_roles WHERE user_id=?",
      actor.id,
    );
    need(
      !roles.some((entry) =>
        ["admin", "finance", "safety", "host_reviewer"].includes(entry.role),
      ),
      "STAFF_HANDOFF_REQUIRED",
      "Transfer staff responsibilities and remove privileged roles before closing this account.",
      409,
    );
    const paidActive = await all(
      "SELECT id FROM mp_bookings WHERE (customer_id=? OR host_id=?) AND status IN ('READY','LIVE')",
      actor.id,
      actor.id,
    );
    if (paidActive.length) {
      need(
        typeof endSession === "function",
        "ACTIVE_SESSION",
        "End the active session before closing your account.",
      );
      for (const booking of paidActive) await endSession(actor, booking.id);
    }
    const now = clock(),
      requestId = crypto.randomUUID(),
      receiptToken = token(),
      reviewed = validPolicy(policy) ? policyCopy(policy) : null;
    const closing = (query, ...values) =>
      sql(
        query + " AND EXISTS(SELECT 1 FROM mp_privacy_deletions WHERE id=?)",
        ...values,
        requestId,
      );
    const changes = await db.batch([
      sql(
        "INSERT OR IGNORE INTO mp_privacy_deletions(id,user_id,request_key,receipt_hash,status,policy_version,policy_snapshot,requested_at,eligible_at,next_attempt_at,wait_reason) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mp_users WHERE id=? AND status='ACTIVE') AND NOT EXISTS(SELECT 1 FROM mp_bookings WHERE (customer_id=? OR host_id=?) AND status IN ('READY','LIVE')) AND NOT EXISTS(SELECT 1 FROM mp_user_roles WHERE user_id=? AND role IN ('admin','finance','safety','host_reviewer'))",
        requestId,
        actor.id,
        requestKey,
        await digest(receiptToken),
        "REQUESTED",
        reviewed?.version || null,
        reviewed ? JSON.stringify(reviewed) : null,
        now,
        reviewed ? now + reviewed.deletionDelayMs : null,
        now,
        reviewed ? null : "POLICY_NOT_REVIEWED",
        actor.id,
        actor.id,
        actor.id,
        actor.id,
      ),
      sql(
        "INSERT OR IGNORE INTO mp_privacy_subject_blocks SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM mp_privacy_deletions WHERE id=?)",
        await digest(user.provider_subject),
        actor.id,
        now,
        requestId,
      ),
      closing("UPDATE mp_users SET status='CLOSED' WHERE id=?", actor.id),
      closing(
        "UPDATE mp_auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE subject=?",
        now,
        user.provider_subject,
      ),
      closing(
        "UPDATE mp_host_profiles SET status='SUSPENDED',updated_at=? WHERE user_id=?",
        now,
        actor.id,
      ),
      closing(
        "UPDATE mp_host_presence SET available=0,last_seen_at=? WHERE host_id=?",
        now,
        actor.id,
      ),
      closing(
        "INSERT INTO mp_booking_events SELECT lower(hex(randomblob(16))),b.id,?,'account-closed','CANCELLED',? FROM mp_bookings b WHERE (b.customer_id=? OR b.host_id=?) AND b.status IN ('REQUESTED','ACCEPTED') AND NOT EXISTS(SELECT 1 FROM mp_payments p WHERE p.booking_id=b.id AND p.status IN ('CAPTURED','DISPUTED'))",
        actor.id,
        now,
        actor.id,
        actor.id,
      ),
      closing(
        "UPDATE mp_bookings SET status='CANCELLED',updated_at=? WHERE (customer_id=? OR host_id=?) AND status IN ('REQUESTED','ACCEPTED') AND NOT EXISTS(SELECT 1 FROM mp_payments p WHERE p.booking_id=mp_bookings.id AND p.status IN ('CAPTURED','DISPUTED'))",
        now,
        actor.id,
        actor.id,
      ),
      closing(
        "DELETE FROM mp_host_claims WHERE booking_id IN (SELECT id FROM mp_bookings WHERE (customer_id=? OR host_id=?) AND status NOT IN ('REQUESTED','ACCEPTED','READY','LIVE'))",
        actor.id,
        actor.id,
      ),
      closing("DELETE FROM mp_user_roles WHERE user_id=?", actor.id),
      closing("DELETE FROM mp_customer_eligibility WHERE user_id=?", actor.id),
      sql(
        "INSERT INTO mp_privacy_events SELECT ?,?,?,'account-closed',?,? WHERE EXISTS(SELECT 1 FROM mp_privacy_deletions WHERE id=?)",
        crypto.randomUUID(),
        requestId,
        actor.id,
        JSON.stringify({ policyVersion: reviewed?.version || null }),
        clock(),
        requestId,
      ),
    ]);
    if (changes[0].meta.changes !== 1) {
      const replay = await first(
        "SELECT * FROM mp_privacy_deletions WHERE user_id=?",
        actor.id,
      );
      if (!replay) {
        need(
          attempt < 2,
          "CONCURRENT_UPDATE",
          "The account changed while closing. Retry after the active session ends.",
        );
        return request(actor, payload, key, attempt + 1);
      }
      need(
        replay?.request_key === requestKey,
        "DELETION_ALREADY_REQUESTED",
        "Account closure has already been requested.",
      );
      return { ...publicStatus(replay), accessClosed: true, replayed: true };
    }
    return {
      ...publicStatus(
        await first("SELECT * FROM mp_privacy_deletions WHERE id=?", requestId),
      ),
      receiptToken,
      accessClosed: true,
    };
  }
  async function receipt(receiptToken) {
    need(
      typeof receiptToken === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(receiptToken),
      "NOT_FOUND",
      "Closure receipt not found.",
      404,
    );
    const row = await first(
      "SELECT * FROM mp_privacy_deletions WHERE receipt_hash=?",
      await digest(receiptToken),
    );
    need(row, "NOT_FOUND", "Closure receipt not found.", 404);
    return publicStatus(row);
  }
  // The HTTP owner must obtain subject from verified provider credentials, never request JSON.
  async function statusForIdentity(verifiedSubject) {
    const row = await first(
      "SELECT d.* FROM mp_privacy_deletions d JOIN mp_privacy_subject_blocks s ON s.user_id=d.user_id WHERE s.subject_hash=?",
      await digest(text(verifiedSubject, 255)),
    );
    need(row, "NOT_FOUND", "Closure request not found.", 404);
    return publicStatus(row);
  }
  async function queue(actor) {
    await check(actor, ["admin"], true);
    const rows = await all(
      "SELECT d.id,d.user_id,d.status,d.policy_version,d.requested_at,d.eligible_at,d.next_attempt_at,d.completed_at,d.attempts,d.wait_reason,(SELECT COUNT(*) FROM mp_privacy_holds h WHERE h.request_id=d.id AND h.status='ACTIVE') holds FROM mp_privacy_deletions d ORDER BY d.requested_at LIMIT 100",
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        holdsDetails: await all(
          "SELECT id,scope,created_at FROM mp_privacy_holds WHERE request_id=? AND status='ACTIVE'",
          row.id,
        ),
      })),
    );
  }
  async function hold(actor, payload, key) {
    await check(actor, ["admin"], true);
    const requestKey = text(key, 128),
      reason = text(payload.reason, 2000),
      requestId = text(payload.requestId, 128),
      action = payload.action;
    need(
      ["PLACE", "RELEASE"].includes(action),
      "VALIDATION",
      "Choose a hold action.",
      400,
    );
    const deletion = await first(
      "SELECT * FROM mp_privacy_deletions WHERE id=?",
      requestId,
    );
    need(deletion, "NOT_FOUND", "Closure request not found.", 404);
    need(
      deletion.status !== "COMPLETED",
      "ALREADY_ERASED",
      "Erased private data cannot be restored.",
    );
    if (action === "PLACE") {
      need(
        ["ALL", "FINANCIAL", "SAFETY"].includes(payload.scope),
        "VALIDATION",
        "Choose a retention hold scope.",
        400,
      );
      const existing = await first(
        "SELECT * FROM mp_privacy_holds WHERE created_by=? AND request_key=?",
        actor.id,
        requestKey,
      );
      if (existing) {
        need(
          existing.request_id === requestId &&
            existing.reason === reason &&
            existing.scope === payload.scope,
          "KEY_REUSED",
          "This request key belongs to a different hold.",
        );
        return { holdId: existing.id, status: existing.status, replayed: true };
      }
      const holdId = crypto.randomUUID();
      const changes = await db.batch([
        sql(
          "INSERT INTO mp_privacy_holds(id,request_id,user_id,scope,reason,status,created_by,created_at,request_key) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mp_privacy_purge_leases WHERE request_id=? AND expires_at>?) AND EXISTS(SELECT 1 FROM mp_privacy_deletions WHERE id=? AND status<>'COMPLETED')",
          holdId,
          requestId,
          deletion.user_id,
          payload.scope,
          reason,
          "ACTIVE",
          actor.id,
          clock(),
          requestKey,
          requestId,
          clock(),
          requestId,
        ),
        sql(
          "INSERT INTO mp_privacy_events SELECT ?,?,?, 'hold-placed',?,? WHERE EXISTS(SELECT 1 FROM mp_privacy_holds WHERE id=?)",
          crypto.randomUUID(),
          requestId,
          actor.id,
          JSON.stringify({ holdId, scope: payload.scope }),
          clock(),
          holdId,
        ),
      ]);
      need(
        changes[0].meta.changes === 1,
        "PURGE_IN_PROGRESS",
        "A privacy job owns this request. Retry after its lease ends.",
      );
      return { holdId, status: "ACTIVE", replayed: false };
    }
    const holdId = text(payload.holdId, 128),
      current = await first(
        "SELECT * FROM mp_privacy_holds WHERE id=? AND request_id=?",
        holdId,
        requestId,
      );
    need(current, "NOT_FOUND", "Retention hold not found.", 404);
    if (current.status === "RELEASED")
      return { holdId, status: "RELEASED", replayed: true };
    await db.batch([
      sql(
        "UPDATE mp_privacy_holds SET status='RELEASED',released_by=?,released_at=?,release_reason=? WHERE id=? AND status='ACTIVE'",
        actor.id,
        clock(),
        reason,
        holdId,
      ),
      sql(
        "UPDATE mp_privacy_deletions SET next_attempt_at=? WHERE id=? AND status IN ('REQUESTED','WAITING')",
        clock(),
        requestId,
      ),
      event(requestId, actor.id, "hold-released", { holdId }),
    ]);
    return { holdId, status: "RELEASED", replayed: false };
  }
  async function retry(actor, payload) {
    await check(actor, ["admin"], true);
    const requestId = text(payload.requestId, 128);
    const reason = text(payload.reason, 2000);
    const result = await sql(
      "UPDATE mp_privacy_deletions SET status='WAITING',attempts=0,next_attempt_at=?,wait_reason='OPERATOR_RETRY' WHERE id=? AND status='FAILED'",
      clock(),
      requestId,
    ).run();
    need(result.meta.changes === 1, "INVALID_STATE", "No failed job to retry.");
    await event(requestId, actor.id, "retry-authorized", { reason }).run();
    return { requestId, status: "WAITING" };
  }
  async function blockers(deletion, reviewed) {
    const userId = deletion.user_id;
    const activeHold = await first(
      "SELECT 1 FROM mp_privacy_holds WHERE user_id=? AND status='ACTIVE' UNION SELECT 1 FROM mp_privacy_holds h JOIN mp_safety_reports r ON h.user_id IN (r.reporter_id,r.reported_id) WHERE (r.reporter_id=? OR r.reported_id=?) AND h.status='ACTIVE' LIMIT 1",
      userId,
      userId,
      userId,
    );
    if (activeHold) return { reason: "RETENTION_HOLD", until: clock() + DAY };
    const uploading = await first(
      "SELECT 1 FROM mp_intro_media WHERE host_id=? AND status='UPLOADING'",
      userId,
    );
    const photosPresent = await first(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mp_profile_photos'",
    );
    const photoUploading = photosPresent
      ? await first(
          "SELECT 1 FROM mp_profile_photos WHERE host_id=? AND status='UPLOADING'",
          userId,
        )
      : null;
    if (uploading || photoUploading)
      return { reason: "MEDIA_UPLOAD_IN_PROGRESS", until: clock() + 60000 };
    const active = await first(
      "SELECT 1 FROM mp_bookings WHERE (customer_id=? OR host_id=?) AND status IN ('REQUESTED','ACCEPTED','READY','LIVE')",
      userId,
      userId,
    );
    if (active) return { reason: "ACTIVE_BOOKING", until: clock() + 3600000 };
    const unsettled = await first(
      "SELECT 1 FROM mp_payments p JOIN mp_bookings b ON b.id=p.booking_id WHERE (b.customer_id=? OR b.host_id=?) AND (p.status IN ('PENDING','DISPUTED') OR EXISTS(SELECT 1 FROM mp_refunds r WHERE r.payment_id=p.id AND r.status IN ('OPEN','APPROVED')) OR EXISTS(SELECT 1 FROM mp_financial_jobs j WHERE j.payment_id=p.id AND j.status<>'SUCCEEDED')) LIMIT 1",
      userId,
      userId,
    );
    if (unsettled)
      return { reason: "FINANCIAL_RECONCILIATION", until: clock() + DAY };
    const commercialTables = new Set(
      (
        await all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mp_payout_batches','mp_refund_awards')",
        )
      ).map((row) => row.name),
    );
    const pendingPayout = commercialTables.has("mp_payout_batches")
      ? await first(
          "SELECT 1 FROM mp_payout_batches WHERE host_id=? AND status IN ('REQUESTED','APPROVED','PROCESSING','SUBMITTED','FAILED')",
          userId,
        )
      : null;
    const pendingAward = commercialTables.has("mp_refund_awards")
      ? await first(
          "SELECT 1 FROM mp_refund_awards a JOIN mp_bookings b ON b.id=(SELECT booking_id FROM mp_payments WHERE id=a.payment_id) WHERE (b.customer_id=? OR b.host_id=?) AND a.status IN ('APPROVED','SUBMITTED')",
          userId,
          userId,
        )
      : null;
    if (pendingPayout || pendingAward)
      return { reason: "FINANCIAL_RECONCILIATION", until: clock() + DAY };
    const safety = await first(
      "SELECT 1 FROM mp_safety_reports WHERE (reporter_id=? OR reported_id=?) AND status<>'CLOSED'",
      userId,
      userId,
    );
    if (safety) return { reason: "OPEN_SAFETY_CASE", until: clock() + DAY };
    const financial = await first(
      "SELECT MAX(p.updated_at) latest FROM mp_payments p JOIN mp_bookings b ON b.id=p.booking_id WHERE b.customer_id=? OR b.host_id=?",
      userId,
      userId,
    );
    const safetyDate = await first(
      "SELECT MAX(updated_at) latest FROM mp_safety_reports WHERE reporter_id=? OR reported_id=?",
      userId,
      userId,
    );
    const bookingDate = await first(
      "SELECT MAX(updated_at) latest FROM mp_bookings WHERE customer_id=? OR host_id=?",
      userId,
      userId,
    );
    const journalDate = await first(
      "SELECT MAX(l.created_at) latest FROM mp_ledger_entries l JOIN mp_bookings b ON b.id=l.booking_id WHERE b.customer_id=? OR b.host_id=?",
      userId,
      userId,
    );
    const payoutDate = commercialTables.has("mp_payout_batches")
      ? await first(
          "SELECT MAX(updated_at) latest FROM mp_payout_batches WHERE host_id=?",
          userId,
        )
      : { latest: null };
    const until = Math.max(
      deletion.requested_at + reviewed.deletionDelayMs,
      deletion.requested_at + reviewed.operationalRetentionMs,
      financial.latest === null
        ? 0
        : financial.latest + reviewed.financialRetentionMs,
      journalDate.latest === null
        ? 0
        : journalDate.latest + reviewed.financialRetentionMs,
      payoutDate.latest === null
        ? 0
        : payoutDate.latest + reviewed.financialRetentionMs,
      safetyDate.latest === null
        ? 0
        : safetyDate.latest + reviewed.safetyRetentionMs,
      bookingDate.latest === null
        ? 0
        : bookingDate.latest + reviewed.operationalRetentionMs,
    );
    return until > clock() ? { reason: "REVIEWED_RETENTION", until } : null;
  }
  async function erase(deletion, owner) {
    const userId = deletion.user_id;
    const media = await all(
      "SELECT id,object_key FROM mp_intro_media WHERE host_id=? AND object_key NOT LIKE 'erased/%'",
      userId,
    );
    const extras = new Set(
      (
        await all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mp_profile_photos','mp_host_drafts','mp_request_limits','mp_match_attempts','mp_availability_observations','mp_host_interests','mp_scheduled_reservations','mp_host_schedule_blocks')",
        )
      ).map((row) => row.name),
    );
    const photos = extras.has("mp_profile_photos")
      ? await all(
          "SELECT id,object_key FROM mp_profile_photos WHERE host_id=? AND object_key NOT LIKE 'erased/%'",
          userId,
        )
      : [];
    if (media.length || photos.length)
      need(
        typeof bucket?.delete === "function",
        "MEDIA_NOT_CONFIGURED",
        "Private media cleanup is unavailable.",
        503,
      );
    // An external store cannot transact with SQLite. Revalidate the live lease before
    // each irreversible object deletion; a hold cannot restore already erased bytes.
    for (const item of [...media, ...photos]) {
      const renewed = await sql(
        "UPDATE mp_privacy_purge_leases SET expires_at=? WHERE request_id=? AND owner=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM mp_privacy_holds WHERE user_id=? AND status='ACTIVE')",
        clock() + 60000,
        deletion.id,
        owner,
        clock(),
        userId,
      ).run();
      need(
        renewed.meta.changes === 1,
        "LEASE_LOST",
        "The privacy job must reacquire its lease.",
        409,
      );
      await bucket.delete(item.object_key);
    }
    const now = clock();
    const guard =
      "EXISTS(SELECT 1 FROM mp_privacy_purge_leases WHERE request_id=? AND owner=? AND expires_at>?)";
    const gated = (query, ...values) =>
      sql(query + " AND " + guard, ...values, deletion.id, owner, now);
    const original = await first(
      "SELECT provider_subject FROM mp_users WHERE id=?",
      userId,
    );
    const extraChanges = [];
    if (extras.has("mp_profile_photos"))
      extraChanges.push(
        gated(
          "UPDATE mp_profile_photos SET object_key='erased/'||id,alt_text='',byte_length=0,reason=NULL,status='FAILED',updated_at=? WHERE host_id=?",
          now,
          userId,
        ),
      );
    if (extras.has("mp_host_drafts"))
      extraChanges.push(
        gated("DELETE FROM mp_host_drafts WHERE host_id=?", userId),
      );
    if (extras.has("mp_host_interests"))
      extraChanges.push(
        gated("DELETE FROM mp_host_interests WHERE host_id=?", userId),
      );
    if (extras.has("mp_scheduled_reservations"))
      extraChanges.push(
        gated("DELETE FROM mp_scheduled_reservations WHERE (customer_id=? OR host_id=?)", userId, userId),
      );
    if (extras.has("mp_host_schedule_blocks"))
      extraChanges.push(
        gated("DELETE FROM mp_host_schedule_blocks WHERE host_id=?", userId),
      );
    if (extras.has("mp_request_limits"))
      extraChanges.push(
        gated("DELETE FROM mp_request_limits WHERE user_id=?", userId),
      );
    if (extras.has("mp_match_attempts"))
      extraChanges.push(
        gated("DELETE FROM mp_match_attempts WHERE customer_id=?", userId),
      );
    if (extras.has("mp_availability_observations"))
      extraChanges.push(
        gated(
          "DELETE FROM mp_availability_observations WHERE host_id=?",
          userId,
        ),
      );
    const results = await db.batch([
      ...extraChanges,
      gated(
        "UPDATE mp_users SET display_name='Deleted member',provider_subject=? WHERE id=?",
        "erased:" + userId,
        userId,
      ),
      gated(
        "UPDATE mp_host_profiles SET display_name='Former host',biography='',languages='[]',formats='[]',styles='[]',review_reason=NULL,intro_reference=NULL,updated_at=? WHERE user_id=?",
        now,
        userId,
      ),
      gated(
        "UPDATE mp_host_verifications SET status='EXPIRED',provider_reference=?,adult_verified=0,jurisdiction='',payout_status='SUSPENDED' WHERE user_id=?",
        "erased:" + userId,
        userId,
      ),
      gated(
        "DELETE FROM mp_host_verification_evidence WHERE host_id=?",
        userId,
      ),
      gated(
        "UPDATE mp_intro_media SET object_key='erased/'||id,transcript='',checksum='',byte_length=0,status='FAILED',review_reason=NULL,updated_at=? WHERE host_id=?",
        now,
        userId,
      ),
      gated(
        "UPDATE mp_host_appeals SET reason='Erased under reviewed retention policy',resolution=NULL WHERE host_id=?",
        userId,
      ),
      gated(
        "UPDATE mp_certifications SET rubric='Erased under reviewed retention policy',status='REVOKED' WHERE host_id=?",
        userId,
      ),
      gated(
        "UPDATE mp_reviews SET private_feedback=NULL WHERE booking_id IN (SELECT id FROM mp_bookings WHERE customer_id=? OR host_id=?)",
        userId,
        userId,
      ),
      gated(
        "UPDATE mp_review_details SET review_text=NULL,publication_status='NONE' WHERE booking_id IN (SELECT id FROM mp_bookings WHERE customer_id=? OR host_id=?)",
        userId,
        userId,
      ),
      gated(
        "DELETE FROM mp_review_request_keys WHERE booking_id IN (SELECT id FROM mp_bookings WHERE customer_id=? OR host_id=?)",
        userId,
        userId,
      ),
      gated(
        "UPDATE mp_safety_reports SET narrative='Erased under reviewed retention policy' WHERE (reporter_id=? OR reported_id=?)",
        userId,
        userId,
      ),
      gated(
        "UPDATE mp_case_events SET reason='Erased under reviewed retention policy' WHERE case_id IN (SELECT id FROM mp_safety_reports WHERE reporter_id=? OR reported_id=?)",
        userId,
        userId,
      ),
      gated(
        "DELETE FROM mp_delivery_leases WHERE notification_id IN (SELECT id FROM mp_notifications WHERE user_id=?)",
        userId,
      ),
      gated("DELETE FROM mp_notifications WHERE user_id=?", userId),
      gated(
        "DELETE FROM mp_auth_sessions WHERE subject=?",
        original.provider_subject,
      ),
      gated("DELETE FROM mp_analytics_events WHERE user_id=?", userId),
      gated("DELETE FROM mp_rate_limits WHERE user_id=?", userId),
      gated("DELETE FROM mp_host_presence WHERE host_id=?", userId),
      gated(
        "DELETE FROM mp_favourites WHERE (customer_id=? OR host_id=?)",
        userId,
        userId,
      ),
      sql(
        "INSERT INTO mp_privacy_events SELECT ?,?,NULL,'private-data-erased','{}',? WHERE " +
          guard,
        crypto.randomUUID(),
        deletion.id,
        now,
        deletion.id,
        owner,
        now,
      ),
      sql(
        "UPDATE mp_privacy_deletions SET status='COMPLETED',completed_at=?,wait_reason=NULL WHERE id=? AND " +
          guard,
        now,
        deletion.id,
        deletion.id,
        owner,
        now,
      ),
      sql(
        "DELETE FROM mp_privacy_purge_leases WHERE request_id=? AND owner=?",
        deletion.id,
        owner,
      ),
    ]);
    return results[results.length - 2].meta.changes === 1;
  }
  async function run({ limit = 10 } = {}) {
    need(
      Number.isInteger(limit) && limit > 0 && limit <= 25,
      "VALIDATION",
      "Choose a bounded privacy batch.",
      400,
    );
    if (!validPolicy(policy))
      return {
        configured: false,
        scanned: 0,
        erased: 0,
        waiting: 0,
        failed: 0,
      };
    const rows = await all(
      "SELECT * FROM mp_privacy_deletions WHERE status IN ('REQUESTED','WAITING','PROCESSING') AND next_attempt_at<=? ORDER BY requested_at LIMIT ?",
      clock(),
      limit,
    );
    let erased = 0,
      waiting = 0,
      failed = 0;
    for (const deletion of rows) {
      const owner = crypto.randomUUID(),
        now = clock();
      const claim = await sql(
        "INSERT INTO mp_privacy_purge_leases VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE mp_privacy_purge_leases.expires_at<=?",
        deletion.id,
        owner,
        now + 60000,
        now,
      ).run();
      if (claim.meta.changes !== 1) continue;
      try {
        const snapshot = deletion.policy_snapshot
          ? JSON.parse(deletion.policy_snapshot)
          : policyCopy(policy);
        need(
          validPolicy(snapshot),
          "POLICY_NOT_REVIEWED",
          "A reviewed retention policy is required.",
          503,
        );
        if (!deletion.policy_snapshot) {
          await db.batch([
            sql(
              "UPDATE mp_privacy_deletions SET policy_version=?,policy_snapshot=? WHERE id=?",
              snapshot.version,
              JSON.stringify(snapshot),
              deletion.id,
            ),
            event(deletion.id, null, "reviewed-policy-adopted", {
              version: snapshot.version,
            }),
          ]);
        }
        const wait = await blockers(deletion, snapshot);
        if (wait) {
          await db.batch([
            sql(
              "UPDATE mp_privacy_deletions SET status='WAITING',eligible_at=?,next_attempt_at=?,wait_reason=? WHERE id=?",
              wait.until,
              wait.until,
              wait.reason,
              deletion.id,
            ),
            sql(
              "DELETE FROM mp_privacy_purge_leases WHERE request_id=? AND owner=?",
              deletion.id,
              owner,
            ),
          ]);
          waiting++;
          continue;
        }
        await sql(
          "UPDATE mp_privacy_deletions SET status='PROCESSING',attempts=attempts+1 WHERE id=?",
          deletion.id,
        ).run();
        if (await erase(deletion, owner)) erased++;
      } catch (error) {
        const attempts = deletion.attempts + 1;
        await db.batch([
          sql(
            "UPDATE mp_privacy_deletions SET status=?,wait_reason=?,next_attempt_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_privacy_purge_leases WHERE request_id=? AND owner=?)",
            attempts >= 8 ? "FAILED" : "WAITING",
            error?.code === "MEDIA_NOT_CONFIGURED"
              ? "MEDIA_NOT_CONFIGURED"
              : "CLEANUP_RETRY",
            clock() + Math.min(DAY, 1000 * 2 ** attempts),
            deletion.id,
            deletion.id,
            owner,
          ),
          event(deletion.id, null, "cleanup-retry", {
            code:
              error?.code === "MEDIA_NOT_CONFIGURED"
                ? "MEDIA_NOT_CONFIGURED"
                : "CLEANUP_RETRY",
          }),
          sql(
            "DELETE FROM mp_privacy_purge_leases WHERE request_id=? AND owner=?",
            deletion.id,
            owner,
          ),
        ]);
        failed++;
      }
    }
    return { configured: true, scanned: rows.length, erased, waiting, failed };
  }
  async function sweepExpired() {
    if (!validPolicy(policy)) return { configured: false, removed: 0 };
    const results = await db.batch([
      sql(
        "DELETE FROM mp_auth_transactions WHERE expires_at<=?",
        clock() - policy.authenticationRetentionMs,
      ),
      sql(
        "DELETE FROM mp_auth_sessions WHERE (expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)) AND NOT EXISTS(SELECT 1 FROM mp_users u JOIN mp_privacy_holds h ON h.user_id=u.id WHERE u.provider_subject=mp_auth_sessions.subject AND h.status='ACTIVE')",
        clock() - policy.authenticationRetentionMs,
        clock() - policy.authenticationRetentionMs,
      ),
      sql(
        "DELETE FROM mp_analytics_events WHERE occurred_at<? AND user_id NOT IN (SELECT user_id FROM mp_privacy_holds WHERE status='ACTIVE')",
        clock() - policy.telemetryRetentionMs,
      ),
    ]);
    const extraTables = new Set(
      (
        await all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mp_match_attempts','mp_availability_observations')",
        )
      ).map((row) => row.name),
    );
    if (extraTables.has("mp_match_attempts"))
      results.push(
        await sql(
          "DELETE FROM mp_match_attempts WHERE started_at<? AND customer_id NOT IN (SELECT user_id FROM mp_privacy_holds WHERE status='ACTIVE')",
          clock() - policy.telemetryRetentionMs,
        ).run(),
      );
    if (extraTables.has("mp_availability_observations"))
      results.push(
        await sql(
          "DELETE FROM mp_availability_observations WHERE observed_at<? AND host_id NOT IN (SELECT user_id FROM mp_privacy_holds WHERE status='ACTIVE')",
          clock() - policy.telemetryRetentionMs,
        ).run(),
      );
    const removed = results.reduce(
      (sum, result) => sum + result.meta.changes,
      0,
    );
    if (removed)
      await sql(
        "INSERT INTO mp_privacy_retention_runs VALUES(?,?,?,?)",
        crypto.randomUUID(),
        policy.version,
        clock(),
        removed,
      ).run();
    return { configured: true, removed };
  }
  return {
    request,
    receipt,
    statusForIdentity,
    queue,
    hold,
    retry,
    run,
    sweepExpired,
  };
}
