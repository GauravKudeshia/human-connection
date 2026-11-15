-- Additive marketplace session evidence and sandbox financial operations.
CREATE TABLE IF NOT EXISTS mp_video_rooms (
 booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id), room_name TEXT NOT NULL UNIQUE,
 room_url TEXT, status TEXT NOT NULL CHECK(status IN ('PROVISIONING','READY','CLOSING','CLOSED')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cleanup_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mp_provider_events (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, booking_id TEXT REFERENCES mp_bookings(id),
 kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_session_presence (
 booking_id TEXT NOT NULL REFERENCES mp_bookings(id), session_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES mp_users(id), joined_at INTEGER NOT NULL, left_at INTEGER,
 PRIMARY KEY(booking_id,session_id), CHECK(left_at IS NULL OR left_at>=joined_at)
);
CREATE INDEX IF NOT EXISTS mp_session_presence_booking ON mp_session_presence(booking_id,user_id);
CREATE TABLE IF NOT EXISTS mp_session_timing (
 booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id), started_at INTEGER, ended_at INTEGER,
 reason TEXT CHECK(reason IN ('USER_ENDED','DEADLINE','SAFETY','PROVIDER_ENDED')),
 overlap_ms INTEGER NOT NULL DEFAULT 0 CHECK(overlap_ms>=0), revision INTEGER NOT NULL DEFAULT 0,
 reconcile_token TEXT
);
CREATE TABLE IF NOT EXISTS mp_tips (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE REFERENCES mp_bookings(id),
 customer_id TEXT NOT NULL REFERENCES mp_users(id), provider_id TEXT NOT NULL UNIQUE,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 100 AND 10000),
 request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','CAPTURED','REFUNDED')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_financial_jobs (
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 kind TEXT NOT NULL CHECK(kind IN ('REFUND','TIP_REFUND','RECONCILE')),
 reference_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL,
 UNIQUE(kind,reference_id)
);
CREATE TABLE IF NOT EXISTS mp_disputes (
 provider_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL CHECK(currency='USD'),
 status TEXT NOT NULL, updated_at INTEGER NOT NULL
);

