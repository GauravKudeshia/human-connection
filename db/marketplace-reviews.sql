-- Preserve conversation scores, value feedback, and private notes in mp_reviews.
CREATE TABLE IF NOT EXISTS mp_review_details (
 booking_id TEXT PRIMARY KEY REFERENCES mp_reviews(booking_id),
 comfort_rating INTEGER CHECK(comfort_rating IS NULL OR (typeof(comfort_rating)='integer' AND comfort_rating BETWEEN 1 AND 5)),
 review_text TEXT CHECK(length(review_text) BETWEEN 1 AND 1000),
 publication_status TEXT NOT NULL DEFAULT 'NONE' CHECK(publication_status IN ('NONE','PENDING','APPROVED','HIDDEN')),
 text_version INTEGER NOT NULL DEFAULT 0 CHECK(text_version>=0),
 CHECK((publication_status='NONE') = (review_text IS NULL))
);
CREATE INDEX IF NOT EXISTS mp_review_moderation_queue
 ON mp_review_details(publication_status,booking_id)
 WHERE publication_status IN ('PENDING','APPROVED');
CREATE TABLE IF NOT EXISTS mp_review_request_keys (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES mp_users(id),
 request_key TEXT NOT NULL,
 booking_id TEXT NOT NULL REFERENCES mp_bookings(id),
 fingerprint TEXT NOT NULL,
 UNIQUE(customer_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_review_request_by_booking ON mp_review_request_keys(booking_id);
