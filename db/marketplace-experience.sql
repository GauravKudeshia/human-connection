-- Additive experience records. No demo hosts or fabricated performance are seeded.
CREATE TABLE IF NOT EXISTS mp_booking_replacements (
 previous_booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id),
 next_booking_id TEXT NOT NULL UNIQUE REFERENCES mp_bookings(id),
 customer_id TEXT NOT NULL REFERENCES mp_users(id),created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_host_drafts (
 host_id TEXT PRIMARY KEY REFERENCES mp_users(id),document TEXT NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_profile_photos (
 id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES mp_users(id),object_key TEXT NOT NULL UNIQUE,
 content_type TEXT NOT NULL,byte_length INTEGER NOT NULL,alt_text TEXT NOT NULL,consent_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('UPLOADING','PENDING','APPROVED','REJECTED','FAILED')),
 reviewer_id TEXT REFERENCES mp_users(id),reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(host_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_photos_review ON mp_profile_photos(status,created_at);
CREATE TABLE IF NOT EXISTS mp_request_limits (
 user_id TEXT NOT NULL REFERENCES mp_users(id),bucket TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,
 PRIMARY KEY(user_id,bucket,window)
);

CREATE TABLE IF NOT EXISTS mp_refund_request_keys (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES mp_users(id),request_key TEXT NOT NULL,
 booking_id TEXT NOT NULL REFERENCES mp_bookings(id),fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(user_id,request_key)
);
-- Staff and booking transition evidence is never rewritten by application operations.
CREATE TRIGGER IF NOT EXISTS mp_audit_no_update BEFORE UPDATE ON mp_audit_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_audit_no_delete BEFORE DELETE ON mp_audit_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_booking_event_no_update BEFORE UPDATE ON mp_booking_events BEGIN SELECT RAISE(ABORT,'Booking events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_booking_event_no_delete BEFORE DELETE ON mp_booking_events BEGIN SELECT RAISE(ABORT,'Booking events are append-only'); END;
