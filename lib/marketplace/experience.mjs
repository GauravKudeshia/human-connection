import { requireCondition as need, text } from "./errors.mjs";
import { fingerprint } from "../fingerprint.mjs";
import { publishedReviews, reviewStatistics } from "./reviews.mjs";
import { normalizeHostLanguages } from "../conversation-languages.mjs";
import { normalizeHostInterests } from "./host-interests.mjs";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
// Strip ancillary metadata before storage; SVG, animation and arbitrary executable uploads are excluded.
export function sanitizeProfilePng(bytes) {
  need(
    bytes instanceof Uint8Array &&
      bytes.length <= 1048576 &&
      bytes.length >= 45 &&
      pngSignature.every((v, i) => bytes[i] === v),
    "INVALID_MEDIA",
    "Choose a PNG photo no larger than 1 MiB.",
    400,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    parts = [bytes.slice(0, 8)];
  let offset = 8,
    header = false,
    image = false,
    ended = false;
  const keep = new Set([
    "IHDR",
    "PLTE",
    "tRNS",
    "IDAT",
    "IEND",
    "sRGB",
    "gAMA",
    "cHRM",
  ]);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8)),
      end = offset + length + 12;
    need(
      end <= bytes.length && /^[A-Za-z]{4}$/.test(type),
      "INVALID_MEDIA",
      "The PNG photo is invalid.",
      400,
    );
    let crc = 0xffffffff;
    for (const value of bytes.slice(offset + 4, end - 4)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    need(
      (crc ^ 0xffffffff) >>> 0 === view.getUint32(end - 4),
      "INVALID_MEDIA",
      "The PNG photo failed its integrity check.",
      400,
    );
    if (!header) {
      need(
        type === "IHDR" && length === 13,
        "INVALID_MEDIA",
        "The PNG photo needs a valid header.",
        400,
      );
      const width = view.getUint32(offset + 8),
        height = view.getUint32(offset + 12);
      need(
        width > 0 && height > 0 && width <= 2048 && height <= 2048,
        "INVALID_MEDIA",
        "Photo dimensions must be at most 2048 × 2048.",
        400,
      );
      header = true;
    } else need(type !== "IHDR", "INVALID_MEDIA", "Duplicate PNG header.", 400);
    need(
      !["acTL", "fcTL", "fdAT"].includes(type) &&
        (keep.has(type) || type[0] === type[0].toLowerCase()),
      "INVALID_MEDIA",
      "Choose a still PNG photo.",
      400,
    );
    if (type === "IDAT") image = true;
    if (keep.has(type)) parts.push(bytes.slice(offset, end));
    offset = end;
    if (type === "IEND") {
      need(
        length === 0 && offset === bytes.length,
        "INVALID_MEDIA",
        "The PNG photo has trailing data.",
        400,
      );
      ended = true;
      break;
    }
  }
  need(
    header && image && ended,
    "INVALID_MEDIA",
    "The PNG photo is incomplete.",
    400,
  );
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

/** @param {any} db @param {{authorize?:any,service?:any,bucket?:any,clock?:()=>number}} [options] */
export function createExperienceService(
  db,
  { authorize, service, bucket, clock = Date.now } = {},
) {
  const sql = (q, ...v) => db.prepare(q).bind(...v);
  const rows = async (q, ...v) => (await sql(q, ...v).all()).results;
  async function check(actor, roles = [], mfa = false) {
    need(
      typeof authorize === "function",
      "AUTH_NOT_CONFIGURED",
      "Verified authorization is required.",
      503,
    );
    return authorize(actor, roles, mfa);
  }
  async function replace(actor, bookingId) {
    await check(actor, ["customer"]);
    const previous = await service.read(actor, "booking", bookingId);
    need(
      previous.customer_id === actor.id,
      "NOT_FOUND",
      "Booking not found.",
      404,
    );
    const existing = await sql(
      "SELECT next_booking_id FROM mp_booking_replacements WHERE previous_booking_id=? AND customer_id=?",
      previous.id,
      actor.id,
    ).first();
    if (existing)
      return {
        booking: await service.read(actor, "booking", existing.next_booking_id),
        replayed: true,
      };
    need(
      ["DECLINED", "EXPIRED"].includes(previous.status),
      "INVALID_STATE",
      "Replacement is available after an unpaid host decline or expiry.",
    );
    const payment = await sql(
      "SELECT id FROM mp_payments WHERE booking_id=?",
      previous.id,
    ).first();
    need(
      !payment,
      "PAYMENT_REVIEW_REQUIRED",
      "A payment was started for this booking. Resolve it before choosing a replacement.",
    );
    const excluded = [previous.host_id];
    let cursor = previous.id;
    for (let n = 0; n < 7; n++) {
      const prior = await sql(
        "SELECT b.id,b.host_id FROM mp_booking_replacements r JOIN mp_bookings b ON b.id=r.previous_booking_id WHERE r.next_booking_id=?",
        cursor,
      ).first();
      if (!prior) break;
      excluded.push(prior.host_id);
      cursor = prior.id;
    }
    need(
      excluded.length < 8,
      "REPLACEMENT_LIMIT",
      "Please adjust your choices after eight host attempts.",
    );
    const result = await service.act(
      actor,
      "reserve",
      {
        experience: previous.experience,
        duration: previous.duration,
        format: previous.format,
        language: previous.language,
        style: previous.quote.style,
        excludeHostIds: excluded,
      },
      "replace:" + previous.id,
    );
    await db.batch([
      sql(
        "INSERT OR IGNORE INTO mp_booking_replacements VALUES(?,?,?,?)",
        previous.id,
        result.booking.id,
        actor.id,
        clock(),
      ),
      sql(
        "INSERT INTO mp_audit_events SELECT ?,?,?,'host-replacement','{}',? WHERE NOT EXISTS(SELECT 1 FROM mp_audit_events WHERE subject_id=? AND action='host-replacement')",
        crypto.randomUUID(),
        actor.id,
        previous.id,
        clock(),
        previous.id,
      ),
    ]);
    return { ...result, replacedBookingId: previous.id };
  }
  async function profiles(actor, hosts) {
    await check(actor);
    return Promise.all(
      hosts.map(async (host) => {
        const {
          delivered,
          ratings,
          averageRating,
          comfortRatings,
          averageComfortRating,
          publishedReviews: totalPublishedReviews,
        } = await reviewStatistics(db, host.user_id);
        const repeat = await sql(
          "SELECT COUNT(*) count FROM mp_bookings WHERE host_id=? AND customer_id=? AND status='COMPLETED'",
          host.user_id,
          actor.id,
        ).first();
        const badges = await rows(
          "SELECT experience,expires_at FROM mp_certifications WHERE host_id=? AND status='APPROVED' AND expires_at>?",
          host.user_id,
          clock(),
        );
        const photo = await sql(
          "SELECT id,alt_text FROM mp_profile_photos WHERE host_id=? AND status='APPROVED' ORDER BY updated_at DESC,id LIMIT 1",
          host.user_id,
        ).first();
        return {
          ...host,
          statistics: { delivered, ratings, averageRating, comfortRatings, averageComfortRating, publishedReviews: totalPublishedReviews },
          writtenReviews: await publishedReviews(db, host.user_id),
          repeatGuest: repeat.count > 0,
          certifications: badges,
          photo: photo || null,
          identityVerified: true,
        };
      }),
    );
  }
  async function quality(actor, hostId = actor.id) {
    await check(
      actor,
      hostId === actor.id ? ["host"] : ["host_reviewer", "admin"],
      hostId !== actor.id,
    );
    const host = await sql(
      "SELECT user_id FROM mp_host_profiles WHERE user_id=?",
      hostId,
    ).first();
    need(host, "NOT_FOUND", "Host profile not found.", 404);
    const stats = await sql(
      "SELECT COUNT(*) requests,SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) delivered,SUM(CASE WHEN status IN ('PARTIAL_DELIVERY','FAILED_SERVICE','SAFETY_ENDED') THEN 1 ELSE 0 END) serviceExceptions FROM mp_bookings WHERE host_id=?",
      hostId,
    ).first();
    const feedback = await reviewStatistics(db, hostId);
    const accepted = await sql(
      "SELECT COUNT(DISTINCT e.booking_id) n FROM mp_booking_events e JOIN mp_bookings b ON b.id=e.booking_id WHERE b.host_id=? AND e.action='accept'",
      hostId,
    ).first();
    const certifications = await rows(
      "SELECT experience,status,rubric,reviewed_at,expires_at,version FROM mp_certifications WHERE host_id=?",
      hostId,
    );
    return {
      hostId,
      ...stats,
      ...feedback,
      writtenReviews: await publishedReviews(db, hostId, 10),
      accepted: accepted.n,
      certifications,
      definitions: {
        value:
          "Scores are averaged separately across completed, paid sessions. Each score shows its response count. Written reviews are shared only after moderator approval.",
        acceptance: "Distinct accepted requests divided by all requests.",
      },
    };
  }
  async function saveDraft(actor, payload) {
    await check(actor);
    const current = await sql(
      "SELECT status FROM mp_host_profiles WHERE user_id=?",
      actor.id,
    ).first();
    need(
      !current || ["DRAFT", "REJECTED"].includes(current.status),
      "INVALID_STATE",
      "Submitted applications cannot be edited as drafts.",
    );
    need(
      payload && typeof payload === "object" && !Array.isArray(payload),
      "VALIDATION",
      "Provide an application draft.",
      400,
    );
    const languages = normalizeHostLanguages(payload.languages ?? []);
    need(languages, "VALIDATION", "Choose valid conversation languages.", 400);
    const clean = {
      displayName: String(payload.displayName || "").slice(0, 100),
      biography: String(payload.biography || "").slice(0, 1000),
      interests: normalizeHostInterests(payload.interests),
      languages,
      formats: Array.isArray(payload.formats)
        ? payload.formats
            .filter((v) => ["audio", "video"].includes(v))
            .slice(0, 2)
        : [],
      styles: Array.isArray(payload.styles)
        ? payload.styles
            .filter((v) => typeof v === "string" && v.length < 60)
            .slice(0, 9)
        : [],
    };
    const saved = await sql(
      "INSERT INTO mp_host_drafts SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM mp_users WHERE id=? AND status='ACTIVE') ON CONFLICT(host_id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at WHERE EXISTS(SELECT 1 FROM mp_users WHERE id=? AND status='ACTIVE')",
      actor.id,
      JSON.stringify(clean),
      clock(),
      actor.id,
      actor.id,
    ).run();
    need(
      saved.meta.changes === 1,
      "ACCOUNT_UNAVAILABLE",
      "This account is unavailable.",
      403,
    );
    return { saved: true };
  }
  async function draft(actor) {
    await check(actor);
    const row = await sql(
      "SELECT document FROM mp_host_drafts WHERE host_id=?",
      actor.id,
    ).first();
    return row ? JSON.parse(row.document) : null;
  }
  async function uploadPhoto(actor, payload, key) {
    await check(actor);
    need(
      bucket?.put,
      "STORAGE_NOT_CONFIGURED",
      "Private photo storage is not configured.",
      503,
    );
    const host = await sql(
      "SELECT status FROM mp_host_profiles WHERE user_id=?",
      actor.id,
    ).first();
    need(
      host && host.status !== "SUSPENDED",
      "INVALID_STATE",
      "Submit a host application before uploading a photo.",
    );
    need(
      payload.consent === true,
      "CONSENT_REQUIRED",
      "Confirm you may publish this photo.",
      400,
    );
    const alt = text(payload.altText, 160),
      requestKey = text(key, 128),
      bytes = sanitizeProfilePng(payload.bytes);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    const fp = fingerprint(JSON.stringify({ digest, alt }));
    const previous = await sql(
      "SELECT id,fingerprint,status FROM mp_profile_photos WHERE host_id=? AND request_key=?",
      actor.id,
      requestKey,
    ).first();
    if (previous) {
      need(
        previous.fingerprint === fp,
        "KEY_REUSED",
        "The upload key belongs to another photo.",
      );
      need(
        !["FAILED", "UPLOADING"].includes(previous.status),
        "UPLOAD_FAILED",
        "Try uploading again with a new request.",
        503,
      );
      return { photoId: previous.id, status: previous.status, replayed: true };
    }
    const photoId = crypto.randomUUID(),
      objectKey = "profile-photos/" + actor.id + "/" + photoId;
    // Atomic pending cap prevents unbounded uploads from one account.
    const result = await sql(
      "INSERT INTO mp_profile_photos SELECT ?,?,?,'image/png',?,?,?,'UPLOADING',NULL,NULL,?,?,?,? WHERE (SELECT COUNT(*) FROM mp_profile_photos WHERE host_id=? AND status IN ('PENDING','UPLOADING'))<3 AND EXISTS(SELECT 1 FROM mp_users WHERE id=? AND status='ACTIVE')",
      photoId,
      actor.id,
      objectKey,
      bytes.length,
      alt,
      clock(),
      clock(),
      clock(),
      requestKey,
      fp,
      actor.id,
      actor.id,
    ).run();
    need(
      result.meta.changes === 1,
      "UPLOAD_LIMIT",
      "You already have three photos awaiting review.",
    );
    try {
      await bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      await check(actor);
      await sql(
        "UPDATE mp_profile_photos SET status='PENDING',updated_at=? WHERE id=? AND status='UPLOADING'",
        clock(),
        photoId,
      ).run();
    } catch {
      await bucket.delete?.(objectKey).catch(() => {});
      await sql(
        "UPDATE mp_profile_photos SET status='FAILED',updated_at=? WHERE id=?",
        clock(),
        photoId,
      ).run();
      need(false, "UPLOAD_FAILED", "The photo upload failed. Try again.", 503);
    }
    return { photoId, status: "PENDING" };
  }
  async function photoReview(actor, payload) {
    await check(actor, ["host_reviewer", "admin"], true);
    const photo = await sql(
      "SELECT * FROM mp_profile_photos WHERE id=?",
      text(payload.photoId, 128),
    ).first();
    need(
      photo && photo.status === "PENDING",
      "INVALID_STATE",
      "This photo is not awaiting review.",
    );
    need(
      actor.id !== photo.host_id,
      "FORBIDDEN",
      "Another reviewer must review this photo.",
      403,
    );
    need(
      ["APPROVED", "REJECTED"].includes(payload.status),
      "VALIDATION",
      "Choose a photo decision.",
      400,
    );
    const reason = text(payload.reason),
      eventId = crypto.randomUUID();
    const result = await db.batch([
      sql(
        "INSERT INTO mp_audit_events SELECT ?,?,?,'photo-reviewed',?,? FROM mp_profile_photos WHERE id=? AND status='PENDING'",
        eventId,
        actor.id,
        photo.id,
        JSON.stringify({ status: payload.status, reason }),
        clock(),
        photo.id,
      ),
      sql(
        "UPDATE mp_profile_photos SET status=?,reviewer_id=?,reason=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)",
        payload.status,
        actor.id,
        reason,
        clock(),
        photo.id,
        eventId,
      ),
    ]);
    need(
      result[0].meta.changes === 1,
      "CONCURRENT_UPDATE",
      "The photo changed during review.",
    );
    return { status: payload.status };
  }
  async function photos(actor, review = false) {
    await check(actor, review ? ["host_reviewer", "admin"] : [], review);
    return rows(
      review
        ? "SELECT id,host_id,alt_text,status,created_at FROM mp_profile_photos WHERE status='PENDING' ORDER BY created_at LIMIT 100"
        : "SELECT id,host_id,alt_text,status,created_at FROM mp_profile_photos WHERE host_id=? ORDER BY created_at DESC LIMIT 20",
      ...(review ? [] : [actor.id]),
    );
  }
  async function photo(actor, photoId) {
    const roles = await check(actor),
      row = await sql(
        "SELECT p.*,h.status host_status,u.status account_status FROM mp_profile_photos p JOIN mp_host_profiles h ON h.user_id=p.host_id JOIN mp_users u ON u.id=p.host_id WHERE p.id=?",
        text(photoId, 128),
      ).first();
    need(row, "NOT_FOUND", "Photo not found.", 404);
    const reviewer = roles.some((v) => ["host_reviewer", "admin"].includes(v));
    if (reviewer && actor.id !== row.host_id)
      await check(actor, ["host_reviewer", "admin"], true);
    const blocked = await sql(
      "SELECT 1 n FROM mp_blocks WHERE (owner_id=? AND blocked_id=?) OR (owner_id=? AND blocked_id=?)",
      actor.id,
      row.host_id,
      row.host_id,
      actor.id,
    ).first();
    need(
      actor.id === row.host_id ||
        reviewer ||
        (row.status === "APPROVED" &&
          row.host_status === "APPROVED" &&
          row.account_status === "ACTIVE" &&
          !blocked),
      "NOT_FOUND",
      "Photo not found.",
      404,
    );
    need(
      bucket?.get,
      "STORAGE_NOT_CONFIGURED",
      "Private photo storage is unavailable.",
      503,
    );
    const object = await bucket.get(row.object_key);
    need(object, "NOT_FOUND", "Photo not found.", 404);
    return {
      body: object.body,
      byteLength: row.byte_length,
      contentType: "image/png",
    };
  }
  return {
    replace,
    profiles,
    quality,
    saveDraft,
    draft,
    uploadPhoto,
    photoReview,
    photos,
    photo,
  };
}
