import { MarketplaceError, requireCondition as need, text } from "./errors.mjs";
import { fingerprint } from "../fingerprint.mjs";
export const CURRENT_POLICY = "beta-2026-11";
const mediaTypes = new Set([
  "audio/webm",
  "video/webm",
  "audio/mp4",
  "video/mp4",
  "audio/mpeg",
  "audio/ogg",
]);
const maxBytes = 8 * 1024 * 1024;
function magic(bytes, type) {
  if (type.endsWith("/webm"))
    return (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  if (type.endsWith("/mp4"))
    return String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  if (type === "audio/ogg")
    return String.fromCharCode(...bytes.slice(0, 4)) === "OggS";
  return (
    String.fromCharCode(...bytes.slice(0, 3)) === "ID3" ||
    (bytes[0] === 255 && (bytes[1] & 224) === 224)
  );
}
/**
 * @param {any} db
 * @param {{clock?:()=>number,bucket?:any,authorize?:(actor:any,roles?:string[],mfa?:boolean)=>Promise<any>,verificationProvider?:any}} [options]
 */
export function createOnboarding(
  db,
  { clock = Date.now, bucket, authorize, verificationProvider } = {},
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
  const audit = (actor, subject, action, details = {}) =>
    sql(
      "INSERT INTO mp_audit_events VALUES(?,?,?,?,?,?)",
      crypto.randomUUID(),
      actor.id,
      subject,
      action,
      JSON.stringify(details),
      clock(),
    );
  async function eligibility(actor) {
    await check(actor, ["customer"]);
    const row = await sql(
      "SELECT policy_version,accepted_at FROM mp_customer_eligibility WHERE user_id=?",
      actor.id,
    ).first();
    return {
      eligible: row?.policy_version === CURRENT_POLICY,
      policyVersion: CURRENT_POLICY,
      acceptedAt: row?.accepted_at || null,
    };
  }
  async function act(actor, action, payload = {}, key) {
    await check(actor);
    const now = clock();
    if (action === "customer-eligibility") {
      await check(actor, ["customer"]);
      need(
        payload.adult === true &&
          payload.us === true &&
          payload.accepted === true &&
          payload.policyVersion === CURRENT_POLICY,
        "ELIGIBILITY_REQUIRED",
        "Adult U.S. eligibility and the current policy must be acknowledged.",
        400,
      );
      await db.batch([
        sql(
          "INSERT INTO mp_customer_eligibility VALUES(?,1,1,?,?) ON CONFLICT(user_id) DO UPDATE SET policy_version=excluded.policy_version,accepted_at=excluded.accepted_at",
          actor.id,
          CURRENT_POLICY,
          now,
        ),
        sql(
          "INSERT OR IGNORE INTO mp_policy_acceptances VALUES(?,?,'customer',?,?)",
          crypto.randomUUID(),
          actor.id,
          CURRENT_POLICY,
          now,
        ),
      ]);
      return eligibility(actor);
    }
    if (action === "host-verification-review") {
      await check(actor, ["host_reviewer", "admin"], true);
      const hostId = text(payload.hostId, 128);
      need(
        actor.id !== hostId,
        "FORBIDDEN",
        "A different reviewer must verify this host.",
        403,
      );
      const host = await sql(
        "SELECT user_id FROM mp_host_profiles WHERE user_id=?",
        hostId,
      ).first();
      need(host, "NOT_FOUND", "Host application not found.", 404);
      need(
        verificationProvider?.lookup,
        "PROVIDER_NOT_CONFIGURED",
        "The identity and payout verification provider is not configured.",
        503,
      );
      const identityReference = text(payload.identityReference, 128),
        payoutReference = text(payload.payoutReference, 128);
      const verified = await verificationProvider.lookup({
        identityReference,
        payoutReference,
        hostId,
      });
      need(
        verified.reference === identityReference,
        "PROVIDER_MISMATCH",
        "The verification reference did not match.",
        502,
      );
      need(
        verified.status === "VERIFIED" &&
          verified.adult === true &&
          verified.country === "US" &&
          verified.payoutEligible === true,
        "VERIFICATION_PENDING",
        "Verified adult U.S. identity and payout eligibility are still required.",
      );
      await db.batch([
        sql(
          "INSERT INTO mp_host_verifications VALUES(?,'VERIFIED',?,1,'US','ELIGIBLE',?) ON CONFLICT(user_id) DO UPDATE SET status='VERIFIED',provider_reference=excluded.provider_reference,adult_verified=1,jurisdiction='US',payout_status='ELIGIBLE',reviewed_at=excluded.reviewed_at",
          hostId,
          identityReference,
          now,
        ),
        sql(
          "INSERT INTO mp_host_verification_evidence VALUES(?,?,?,?,?) ON CONFLICT(host_id) DO UPDATE SET identity_reference=excluded.identity_reference,payout_reference=excluded.payout_reference,reviewer_id=excluded.reviewer_id,reviewed_at=excluded.reviewed_at",
          hostId,
          identityReference,
          payoutReference,
          actor.id,
          now,
        ),
        audit(actor, hostId, "host-verification-reviewed", {
          providerVerified: true,
        }),
      ]);
      return { verified: true };
    }
    if (action === "host-intro-review") {
      await check(actor, ["host_reviewer", "admin"], true);
      const intro = await sql(
        "SELECT * FROM mp_intro_media WHERE id=?",
        text(payload.introId, 128),
      ).first();
      need(
        intro && intro.status === "PENDING",
        "INVALID_STATE",
        "This introduction is no longer pending.",
      );
      need(
        intro.host_id !== actor.id,
        "FORBIDDEN",
        "A different reviewer must review this introduction.",
        403,
      );
      need(
        ["APPROVED", "REJECTED"].includes(payload.decision),
        "VALIDATION",
        "Choose an introduction decision.",
        400,
      );
      need(
        payload.decision !== "APPROVED" || payload.durationConfirmed === true,
        "VALIDATION",
        "Confirm the reviewed clip is 15–30 seconds.",
        400,
      );
      const reason = text(payload.reason);
      const eventId = crypto.randomUUID();
      const result = await db.batch([
        sql(
          "INSERT INTO mp_audit_events SELECT ?,?,?,?, ?,? FROM mp_intro_media WHERE id=? AND status='PENDING'",
          eventId,
          actor.id,
          intro.id,
          "intro-reviewed",
          JSON.stringify({ decision: payload.decision, reason }),
          now,
          intro.id,
        ),
        sql(
          "UPDATE mp_intro_media SET status=?,reviewer_id=?,review_reason=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
          payload.decision,
          actor.id,
          reason,
          now,
          intro.id,
          eventId,
        ),
        sql(
          "UPDATE mp_host_profiles SET intro_reference=?,updated_at=? WHERE user_id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?) AND ?='APPROVED'",
          intro.id,
          now,
          intro.host_id,
          eventId,
          payload.decision,
        ),
      ]);
      need(
        result[0].meta.changes === 1,
        "CONCURRENT_UPDATE",
        "This introduction changed during review.",
      );
      return { status: payload.decision };
    }
    if (action === "host-appeal") {
      const profile = await sql(
        "SELECT status FROM mp_host_profiles WHERE user_id=?",
        actor.id,
      ).first();
      need(
        profile && ["REJECTED", "SUSPENDED"].includes(profile.status),
        "INVALID_STATE",
        "Appeals are available for rejected or suspended host applications.",
      );
      const requestKey = text(key, 128),
        reason = text(payload.reason);
      const previous = await sql(
        "SELECT * FROM mp_host_appeals WHERE host_id=? AND request_key=?",
        actor.id,
        requestKey,
      ).first();
      if (previous) {
        need(
          previous.reason === reason,
          "KEY_REUSED",
          "This request key belongs to a different appeal.",
        );
        return { appealId: previous.id, status: previous.status };
      }
      const appealId = crypto.randomUUID();
      try {
        await db.batch([
          sql(
            "INSERT INTO mp_host_appeals VALUES(?,?,?,'OPEN',NULL,NULL,?,?,?)",
            appealId,
            actor.id,
            reason,
            now,
            now,
            requestKey,
          ),
          audit(actor, appealId, "host-appeal-submitted"),
        ]);
      } catch (error) {
        if (/UNIQUE/.test(error.message))
          throw new MarketplaceError(
            "APPEAL_OPEN",
            "An appeal is already open.",
          );
        throw error;
      }
      return { appealId, status: "OPEN" };
    }
    if (action === "appeal-decision") {
      await check(actor, ["host_reviewer", "admin"], true);
      const appeal = await sql(
        "SELECT * FROM mp_host_appeals WHERE id=?",
        text(payload.appealId, 128),
      ).first();
      need(
        appeal?.status === "OPEN",
        "INVALID_STATE",
        "This appeal is no longer open.",
      );
      need(
        appeal.host_id !== actor.id,
        "FORBIDDEN",
        "A different reviewer must resolve this appeal.",
        403,
      );
      need(
        ["APPROVED", "REJECTED"].includes(payload.decision),
        "VALIDATION",
        "Choose an appeal decision.",
        400,
      );
      const reason = text(payload.reason),
        eventId = crypto.randomUUID();
      const result = await db.batch([
        sql(
          "INSERT INTO mp_audit_events SELECT ?,?,?,?, ?,? FROM mp_host_appeals WHERE id=? AND status='OPEN'",
          eventId,
          actor.id,
          appeal.id,
          "appeal-reviewed",
          JSON.stringify({ decision: payload.decision, reason }),
          now,
          appeal.id,
        ),
        sql(
          "UPDATE mp_host_appeals SET status=?,reviewer_id=?,resolution=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
          payload.decision,
          actor.id,
          reason,
          now,
          appeal.id,
          eventId,
        ),
        sql(
          "UPDATE mp_host_profiles SET status='REVIEW_PENDING',updated_at=? WHERE user_id=? AND ?='APPROVED' AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
          now,
          appeal.host_id,
          payload.decision,
          eventId,
        ),
      ]);
      need(
        result[0].meta.changes === 1,
        "CONCURRENT_UPDATE",
        "This appeal changed during review.",
      );
      return {
        status: payload.decision,
        hostApprovalRequired: payload.decision === "APPROVED",
      };
    }
    throw new MarketplaceError(
      "NOT_FOUND",
      "This onboarding operation is unavailable.",
      404,
    );
  }
  async function uploadIntro(
    actor,
    { bytes, contentType, transcript, consent, durationSeconds },
    key,
  ) {
    await check(actor);
    need(
      bucket?.put && bucket?.get && bucket?.delete,
      "MEDIA_NOT_CONFIGURED",
      "Private introduction storage is not configured.",
      503,
    );
    const host = await sql(
      "SELECT user_id FROM mp_host_profiles WHERE user_id=?",
      actor.id,
    ).first();
    need(
      host,
      "APPLICATION_REQUIRED",
      "Submit your host application before adding an introduction.",
    );
    need(
      bytes instanceof Uint8Array &&
        bytes.byteLength >= 12 &&
        bytes.byteLength <= maxBytes &&
        mediaTypes.has(contentType) &&
        magic(bytes, contentType),
      "INVALID_MEDIA",
      "Choose an allowed audio or video clip no larger than 8 MiB.",
      400,
    );
    need(
      consent === true &&
        Number.isInteger(durationSeconds) &&
        durationSeconds >= 15 &&
        durationSeconds <= 30,
      "CONSENT_REQUIRED",
      "Authorize this 15–30 second introduction for review and publication.",
      400,
    );
    const caption = text(transcript, 2000),
      requestKey = text(key, 128),
      now = clock();
    const checksum = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const digest = fingerprint(
      JSON.stringify({ checksum, contentType, caption, durationSeconds }),
    );
    const existing = await sql(
      "SELECT * FROM mp_intro_media WHERE host_id=? AND request_key=?",
      actor.id,
      requestKey,
    ).first();
    if (existing) {
      need(
        existing.fingerprint === digest,
        "KEY_REUSED",
        "This request key belongs to different media.",
      );
      need(
        existing.status !== "UPLOADING",
        "UPLOAD_PENDING",
        "This introduction is still uploading. Retry shortly.",
      );
      return { introId: existing.id, status: existing.status };
    }
    const introId = crypto.randomUUID(),
      objectKey = "host-intros/" + actor.id + "/" + introId;
    try {
      const inserted = await sql(
        "INSERT INTO mp_intro_media(id,host_id,object_key,content_type,byte_length,checksum,transcript,consent_at,duration_seconds,status,request_key,fingerprint,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'UPLOADING',?,?,?,? WHERE (SELECT COUNT(*) FROM mp_intro_media WHERE host_id=? AND status IN ('UPLOADING','PENDING'))<3",
        introId,
        actor.id,
        objectKey,
        contentType,
        bytes.byteLength,
        checksum,
        caption,
        now,
        durationSeconds,
        requestKey,
        digest,
        now,
        now,
        actor.id,
      ).run();
      need(
        inserted.meta.changes === 1,
        "UPLOAD_QUEUE_FULL",
        "Three introductions are already awaiting review.",
        429,
      );
    } catch (error) {
      if (/UNIQUE/.test(error.message)) {
        const saved = await sql(
          "SELECT * FROM mp_intro_media WHERE host_id=? AND request_key=?",
          actor.id,
          requestKey,
        ).first();
        need(
          saved?.fingerprint === digest,
          "KEY_REUSED",
          "This request key belongs to different media.",
        );
        need(
          saved.status !== "UPLOADING",
          "UPLOAD_PENDING",
          "This introduction is still uploading. Retry shortly.",
        );
        return { introId: saved.id, status: saved.status };
      }
      throw error;
    }
    try {
      await bucket.put(objectKey, bytes, { httpMetadata: { contentType } });
      await sql(
        "UPDATE mp_intro_media SET status='PENDING',updated_at=? WHERE id=? AND status='UPLOADING'",
        clock(),
        introId,
      ).run();
    } catch {
      await bucket.delete(objectKey).catch(() => {});
      await sql(
        "UPDATE mp_intro_media SET status='FAILED',updated_at=? WHERE id=?",
        clock(),
        introId,
      ).run();
      throw new MarketplaceError(
        "UPLOAD_FAILED",
        "This introduction could not be stored. Try a new upload.",
        503,
      );
    }
    return { introId, status: "PENDING" };
  }
  async function media(actor, introId) {
    await check(actor);
    need(
      bucket?.get,
      "MEDIA_NOT_CONFIGURED",
      "Private introduction storage is not configured.",
      503,
    );
    const row = await sql(
      "SELECT * FROM mp_intro_media WHERE id=?",
      text(introId, 128),
    ).first();
    need(row, "NOT_FOUND", "Introduction not found.", 404);
    if (row.host_id !== actor.id) {
      const host = await sql(
        "SELECT h.status,u.status account_status FROM mp_host_profiles h JOIN mp_users u ON u.id=h.user_id WHERE h.user_id=?",
        row.host_id,
      ).first();
      if (
        row.status !== "APPROVED" ||
        host?.status !== "APPROVED" ||
        host.account_status !== "ACTIVE"
      )
        await check(actor, ["host_reviewer", "admin"], true);
    }
    need(
      ["PENDING", "APPROVED", "REJECTED"].includes(row.status),
      "NOT_FOUND",
      "Introduction is unavailable.",
      404,
    );
    const object = await bucket.get(row.object_key);
    need(object, "NOT_FOUND", "Introduction is unavailable.", 404);
    return {
      body: object.body,
      contentType: row.content_type,
      byteLength: row.byte_length,
      transcript: row.transcript,
    };
  }
  async function read(actor, resource) {
    await check(actor);
    if (resource === "eligibility") return eligibility(actor);
    if (resource === "my-intros")
      return (
        await sql(
          "SELECT id,content_type,transcript,duration_seconds,status,review_reason,created_at FROM mp_intro_media WHERE host_id=? ORDER BY created_at DESC LIMIT 30",
          actor.id,
        ).all()
      ).results;
    if (resource === "my-appeals")
      return (
        await sql(
          "SELECT id,reason,status,resolution,created_at FROM mp_host_appeals WHERE host_id=? ORDER BY created_at DESC LIMIT 30",
          actor.id,
        ).all()
      ).results;
    await check(actor, ["host_reviewer", "admin"], true);
    if (resource === "intros")
      return (
        await sql(
          "SELECT id,host_id,content_type,transcript,duration_seconds,status,created_at FROM mp_intro_media WHERE status='PENDING' ORDER BY created_at LIMIT 100",
        ).all()
      ).results;
    if (resource === "appeals")
      return (
        await sql(
          "SELECT * FROM mp_host_appeals WHERE status='OPEN' ORDER BY created_at LIMIT 100",
        ).all()
      ).results;
    if (resource === "verifications")
      return (
        await sql(
          "SELECT host_id,identity_reference,payout_reference,reviewed_at FROM mp_host_verification_evidence ORDER BY reviewed_at DESC LIMIT 100",
        ).all()
      ).results;
    throw new MarketplaceError(
      "NOT_FOUND",
      "Onboarding resource not found.",
      404,
    );
  }
  return { act, read, eligibility, uploadIntro, media };
}

/** Sandbox retrieval keeps raw verified identity attributes out of persisted application records. */
/** @param {{secretKey?:string,fetcher?:typeof fetch,clock?:()=>number}} [options] */
export function createStripeVerificationLookup({
  secretKey,
  fetcher = fetch,
  clock = Date.now,
} = {}) {
  need(
    typeof secretKey === "string" && secretKey.startsWith("sk_test_"),
    "VERIFICATION_NOT_CONFIGURED",
    "Configure a Stripe sandbox verification account.",
    503,
  );
  async function get(path) {
    const response = await fetcher("https://api.stripe.com/v1/" + path, {
      headers: { Authorization: "Bearer " + secretKey },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    need(
      response.ok,
      "VERIFICATION_UNAVAILABLE",
      "The verification provider is unavailable.",
      503,
    );
    return response.json();
  }
  return {
    async lookup({ identityReference, payoutReference, hostId }) {
      need(
        /^vs_[A-Za-z0-9_]+$/.test(identityReference) &&
          /^acct_[A-Za-z0-9_]+$/.test(payoutReference),
        "VALIDATION",
        "Choose valid provider references.",
        400,
      );
      const [identity, account] = await Promise.all([
        get(
          "identity/verification_sessions/" +
            identityReference +
            "?expand[]=verified_outputs.dob",
        ),
        get("accounts/" + payoutReference),
      ]);
      need(
        identity.id === identityReference &&
          identity.livemode === false &&
          account.id === payoutReference,
        "PROVIDER_MISMATCH",
        "The sandbox provider objects did not match.",
        502,
      );
      need(
        identity.metadata?.hc_user_id === hostId &&
          account.metadata?.hc_user_id === hostId,
        "VERIFICATION_OWNER_MISMATCH",
        "Provider records belong to a different host.",
        403,
      );
      const dob = identity.verified_outputs?.dob;
      let adult = false;
      if (
        dob &&
        Number.isInteger(dob.year) &&
        Number.isInteger(dob.month) &&
        Number.isInteger(dob.day)
      ) {
        const date = new Date(clock());
        const birthday = new Date(Date.UTC(dob.year, dob.month - 1, dob.day));
        const valid =
          birthday.getUTCFullYear() === dob.year &&
          birthday.getUTCMonth() === dob.month - 1 &&
          birthday.getUTCDate() === dob.day;
        const beforeBirthday =
          date.getUTCMonth() + 1 < dob.month ||
          (date.getUTCMonth() + 1 === dob.month && date.getUTCDate() < dob.day);
        adult =
          valid &&
          date.getUTCFullYear() - dob.year - Number(beforeBirthday) >= 18;
      }
      return {
        reference: identity.id,
        status: identity.status === "verified" ? "VERIFIED" : "PENDING",
        adult,
        country: identity.verified_outputs?.address?.country,
        payoutEligible:
          account.country === "US" &&
          account.payouts_enabled === true &&
          account.details_submitted === true &&
          !account.requirements?.disabled_reason,
      };
    },
  };
}
