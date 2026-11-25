import { fingerprint } from "../fingerprint.mjs";
import { requireCondition as need, text } from "./errors.mjs";

// Bind scores to the matching captured charge on the completed booking.
export const capturedReviewCharge = `EXISTS(
  SELECT 1 FROM mp_payments p WHERE p.booking_id=b.id AND p.status='CAPTURED'
    AND p.amount_cents=b.amount_cents AND p.amount_cents>0 AND p.currency=b.currency
)`;
const reviewEligible = "b.status='COMPLETED' AND " + capturedReviewCharge;
const reviewOwner = `EXISTS(
  SELECT 1 FROM mp_users u WHERE u.id=b.customer_id AND u.status='ACTIVE'
)`;
const ownerReviewJoin = "r.booking_id=b.id AND r.customer_id=b.customer_id";
const validRating = (value) =>
  value === undefined || (Number.isInteger(value) && value >= 1 && value <= 5);
const validNote = (value) =>
  value === undefined || (typeof value === "string" && value.length <= 1000);

export async function reviewStatistics(db, hostId) {
  return db
    .prepare(
      `SELECT COUNT(*) delivered,COUNT(r.rating) ratings,AVG(r.rating) averageRating,
        COUNT(d.comfort_rating) comfortRatings,AVG(d.comfort_rating) averageComfortRating,
        COUNT(CASE WHEN d.publication_status='APPROVED' AND ${reviewOwner} THEN 1 END) publishedReviews,
        COUNT(r.worth_it) valueAnswers,SUM(CASE WHEN r.worth_it=1 THEN 1 ELSE 0 END) valueYes
      FROM mp_bookings b LEFT JOIN mp_reviews r ON ${ownerReviewJoin} AND ${capturedReviewCharge}
      LEFT JOIN mp_review_details d ON d.booking_id=r.booking_id
      WHERE b.host_id=? AND b.status='COMPLETED'`,
    )
    .bind(hostId)
    .first();
}

export async function publishedReviews(db, hostId, limit = 3) {
  const { results } = await db
    .prepare(
      `SELECT d.review_text
       FROM mp_review_details d JOIN mp_reviews r ON r.booking_id=d.booking_id
       JOIN mp_bookings b ON ${ownerReviewJoin}
       WHERE b.host_id=? AND d.publication_status='APPROVED'
         AND ${reviewEligible} AND ${reviewOwner}
       ORDER BY r.created_at DESC,b.id LIMIT ?`,
    )
    .bind(hostId, limit)
    .all();
  return results.map(({ review_text }) => review_text);
}

export function createReviewService(db, { authorize, clock }) {
  const sql = (query, ...values) => db.prepare(query).bind(...values);
  const moderationRoles = ["host_reviewer", "admin"];
  const bookingForReview = (bookingId, customerId) =>
    sql(
      `SELECT b.id,(${reviewEligible}) AS eligible FROM mp_bookings b
       WHERE b.id=? AND b.customer_id=?`,
      text(bookingId, 128),
      customerId,
    ).first();

  async function own(actor, bookingId) {
    const booking = await bookingForReview(bookingId, actor.id);
    need(booking, "NOT_FOUND", "Session not found.", 404);
    const review = await sql(
      `SELECT r.rating,r.worth_it,r.private_feedback,d.comfort_rating,
        d.review_text,d.publication_status FROM mp_reviews r
       LEFT JOIN mp_review_details d ON d.booking_id=r.booking_id
       WHERE r.booking_id=? AND r.customer_id=?`,
      booking.id,
      actor.id,
    ).first();
    return {
      eligible: Boolean(booking.eligible),
      review: review
        ? {
            rating: review.rating,
            comfortRating: review.comfort_rating,
            worthIt: review.worth_it === null ? null : Boolean(review.worth_it),
            privateFeedback: review.private_feedback,
            reviewText: review.review_text,
            publicationStatus: review.publication_status || "NONE",
          }
        : null,
    };
  }

  async function submit(actor, payload, requestKey) {
    const booking = await bookingForReview(payload.bookingId, actor.id);
    need(booking, "NOT_FOUND", "Session not found.", 404);
    const { rating, comfortRating, worthIt, privateFeedback, reviewText } = payload;
    need(
      validRating(rating) && validRating(comfortRating) &&
        (worthIt === undefined || typeof worthIt === "boolean") &&
        validNote(privateFeedback) && validNote(reviewText) &&
        [rating, comfortRating, worthIt, privateFeedback, reviewText].some(
          (entry) => entry !== undefined,
        ) &&
        (!reviewText?.trim() || (rating !== undefined && comfortRating !== undefined)),
      "VALIDATION",
      "Choose ratings from one to five. A written review requires both ratings and can contain up to 1,000 characters.",
      400,
    );
    const note = privateFeedback?.trim() || null;
    const written = reviewText?.trim() || null;
    const key = text(requestKey, 128);
    const digest = fingerprint(
      JSON.stringify({
        bookingId: booking.id,
        rating,
        comfortRating,
        worthIt,
        privateFeedback: privateFeedback === undefined ? undefined : note,
        reviewText: reviewText === undefined ? undefined : written,
      }),
    );
    const marker = crypto.randomUUID();
    const result = await db.batch([
      sql(
        `INSERT OR IGNORE INTO mp_review_request_keys
         SELECT ?,b.customer_id,?,b.id,? FROM mp_bookings b
         WHERE b.id=? AND b.customer_id=? AND ${reviewEligible} AND ${reviewOwner}`,
        marker,
        key,
        digest,
        booking.id,
        actor.id,
      ),
      sql(
        `INSERT INTO mp_reviews(booking_id,customer_id,rating,worth_it,private_feedback,created_at)
         SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mp_review_request_keys WHERE id=?)
         ON CONFLICT(booking_id) DO UPDATE SET
           rating=CASE WHEN ? THEN excluded.rating ELSE rating END,
           worth_it=CASE WHEN ? THEN excluded.worth_it ELSE worth_it END,
           private_feedback=CASE WHEN ? THEN excluded.private_feedback ELSE private_feedback END
         WHERE mp_reviews.customer_id=excluded.customer_id`,
        booking.id,
        actor.id,
        rating ?? null,
        worthIt === undefined ? null : Number(worthIt),
        note,
        clock(),
        marker,
        Number(rating !== undefined),
        Number(worthIt !== undefined),
        Number(privateFeedback !== undefined),
      ),
      sql(
        `INSERT INTO mp_review_details(booking_id,comfort_rating,review_text,publication_status,text_version)
         SELECT ?,?,?,?,? WHERE EXISTS(
           SELECT 1 FROM mp_review_request_keys k JOIN mp_reviews r ON r.booking_id=k.booking_id
           WHERE k.id=? AND r.customer_id=k.customer_id
         )
         ON CONFLICT(booking_id) DO UPDATE SET
           comfort_rating=COALESCE(excluded.comfort_rating,comfort_rating),
           publication_status=CASE WHEN ? AND excluded.review_text IS NOT review_text
             THEN excluded.publication_status ELSE publication_status END,
           text_version=text_version+CASE WHEN ? AND excluded.review_text IS NOT review_text
             THEN 1 ELSE 0 END,
           review_text=CASE WHEN ? THEN excluded.review_text ELSE review_text END`,
        booking.id,
        comfortRating ?? null,
        written,
        written ? "PENDING" : "NONE",
        Number(Boolean(written)),
        marker,
        Number(reviewText !== undefined),
        Number(reviewText !== undefined),
        Number(reviewText !== undefined),
      ),
    ]);
    const stored = await sql(
      "SELECT booking_id,fingerprint FROM mp_review_request_keys WHERE customer_id=? AND request_key=?",
      actor.id,
      key,
    ).first();
    need(stored, "INVALID_STATE", "Review your own completed session with a captured payment.");
    need(
      stored.booking_id === booking.id && stored.fingerprint === digest,
      "KEY_REUSED",
      "This request key belongs to a different review.",
    );
    return result[0].meta.changes ? { saved: true } : { saved: true, replayed: true };
  }

  async function moderationQueue(actor, published, page = 0) {
    await authorize(actor, moderationRoles, true);
    need(
      Number.isInteger(page) && page >= 0 && page <= 10000,
      "VALIDATION",
      "Choose a valid written review page.",
      400,
    );
    const { results } = await sql(
      `SELECT b.id AS bookingId,d.review_text AS reviewText,
        d.publication_status AS publicationStatus,d.text_version AS textVersion
       FROM mp_review_details d JOIN mp_reviews r ON r.booking_id=d.booking_id
       JOIN mp_bookings b ON ${ownerReviewJoin}
       WHERE d.publication_status=?
         AND b.customer_id<>? AND b.host_id<>? AND ${reviewEligible} AND ${reviewOwner}
       ORDER BY r.created_at ${published ? "DESC" : "ASC"},b.id LIMIT 100 OFFSET ?`,
      published ? "APPROVED" : "PENDING",
      actor.id,
      actor.id,
      page * 100,
    ).all();
    return results;
  }

  async function moderate(actor, payload) {
    await authorize(actor, moderationRoles, true);
    const bookingId = text(payload.bookingId, 128);
    const { publicationStatus, textVersion } = payload;
    need(
      ["APPROVED", "HIDDEN"].includes(publicationStatus) &&
        Number.isInteger(textVersion) && textVersion >= 1,
      "VALIDATION",
      "Choose a review decision for the current written review.",
      400,
    );
    const marker = crypto.randomUUID();
    const [event] = await db.batch([
      sql(
        `INSERT INTO mp_audit_events
         SELECT ?,?,b.id,'review-publication',?,? FROM mp_review_details d
         JOIN mp_reviews r ON r.booking_id=d.booking_id
         JOIN mp_bookings b ON ${ownerReviewJoin}
         WHERE b.id=? AND d.text_version=? AND d.publication_status<>?
           AND (d.publication_status='PENDING' OR
             (d.publication_status='APPROVED' AND ?='HIDDEN'))
           AND b.customer_id<>? AND b.host_id<>? AND ${reviewEligible} AND ${reviewOwner}
           AND EXISTS(
             SELECT 1 FROM mp_users u JOIN mp_user_roles roles ON roles.user_id=u.id
             WHERE u.id=? AND u.status='ACTIVE' AND roles.role IN ('host_reviewer','admin')
           )`,
        marker,
        actor.id,
        JSON.stringify({ publicationStatus, textVersion }),
        clock(),
        bookingId,
        textVersion,
        publicationStatus,
        publicationStatus,
        actor.id,
        actor.id,
        actor.id,
      ),
      sql(
        `UPDATE mp_review_details SET publication_status=? WHERE booking_id=?
         AND EXISTS(SELECT 1 FROM mp_audit_events WHERE id=?)`,
        publicationStatus,
        bookingId,
        marker,
      ),
    ]);
    need(event.meta.changes, "INVALID_STATE", "This review has changed or is unavailable. Refresh the moderation queue.");
    return { publicationStatus };
  }

  return { own, submit, moderationQueue, moderate };
}
