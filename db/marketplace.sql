-- Additive staging marketplace schema. Apply to MARKETPLACE_DB, separately from demo DB.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mp_users (
 id TEXT PRIMARY KEY, provider_subject TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_user_roles (
 user_id TEXT NOT NULL REFERENCES mp_users(id), role TEXT NOT NULL
 CHECK(role IN ('customer','host','host_reviewer','safety','finance','admin')),
 PRIMARY KEY(user_id, role)
);
CREATE TABLE IF NOT EXISTS mp_host_profiles (
 user_id TEXT PRIMARY KEY REFERENCES mp_users(id), display_name TEXT NOT NULL,
 biography TEXT NOT NULL, languages TEXT NOT NULL, formats TEXT NOT NULL, styles TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('DRAFT','SUBMITTED','IDENTITY_PENDING','REVIEW_PENDING','APPROVED','REJECTED','SUSPENDED')),
 policy_version TEXT NOT NULL, training_version TEXT NOT NULL, review_reason TEXT,
 intro_reference TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_host_verifications (
 user_id TEXT PRIMARY KEY REFERENCES mp_users(id), status TEXT NOT NULL
 CHECK(status IN ('PENDING','VERIFIED','REJECTED','EXPIRED')), provider_reference TEXT NOT NULL,
 adult_verified INTEGER NOT NULL DEFAULT 0 CHECK(adult_verified IN (0,1)),
 jurisdiction TEXT NOT NULL, payout_status TEXT NOT NULL DEFAULT 'PENDING'
 CHECK(payout_status IN ('PENDING','ELIGIBLE','SUSPENDED')), reviewed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_certifications (
 host_id TEXT NOT NULL REFERENCES mp_users(id), experience TEXT NOT NULL CHECK(experience IN ('laugh','hear','distract')),
 status TEXT NOT NULL CHECK(status IN ('APPROVED','REVOKED')), rubric TEXT NOT NULL,
 reviewer_id TEXT NOT NULL REFERENCES mp_users(id), version INTEGER NOT NULL,
 reviewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(host_id,experience)
);
CREATE TABLE IF NOT EXISTS mp_host_presence (
 host_id TEXT PRIMARY KEY REFERENCES mp_users(id), available INTEGER NOT NULL CHECK(available IN (0,1)),
 last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_bookings (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES mp_users(id), host_id TEXT NOT NULL REFERENCES mp_users(id),
 request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 experience TEXT NOT NULL CHECK(experience IN ('laugh','hear','distract')),
 duration INTEGER NOT NULL CHECK(duration IN (15,30)), format TEXT NOT NULL CHECK(format IN ('audio','video')),
 language TEXT NOT NULL, quote TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
 currency TEXT NOT NULL CHECK(currency='USD'),
 status TEXT NOT NULL CHECK(status IN ('REQUESTED','ACCEPTED','READY','LIVE','COMPLETED','DECLINED','EXPIRED','CANCELLED','PARTIAL_DELIVERY','SAFETY_ENDED','FAILED_SERVICE')),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(customer_id,request_key), CHECK(customer_id<>host_id)
);
CREATE INDEX IF NOT EXISTS mp_bookings_customer ON mp_bookings(customer_id,created_at);
CREATE INDEX IF NOT EXISTS mp_bookings_host ON mp_bookings(host_id,created_at);
CREATE INDEX IF NOT EXISTS mp_bookings_expiry ON mp_bookings(status,expires_at);
CREATE TABLE IF NOT EXISTS mp_host_claims (
 host_id TEXT PRIMARY KEY REFERENCES mp_users(id), customer_id TEXT NOT NULL UNIQUE REFERENCES mp_users(id),
 booking_id TEXT NOT NULL UNIQUE REFERENCES mp_bookings(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_booking_events (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES mp_bookings(id),
 actor_id TEXT REFERENCES mp_users(id), action TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_blocks (
 owner_id TEXT NOT NULL REFERENCES mp_users(id), blocked_id TEXT NOT NULL REFERENCES mp_users(id),
 created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,blocked_id), CHECK(owner_id<>blocked_id)
);
CREATE TABLE IF NOT EXISTS mp_favourites (
 customer_id TEXT NOT NULL REFERENCES mp_users(id), host_id TEXT NOT NULL REFERENCES mp_users(id),
 created_at INTEGER NOT NULL, PRIMARY KEY(customer_id,host_id), CHECK(customer_id<>host_id)
);
CREATE TABLE IF NOT EXISTS mp_safety_reports (
 id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES mp_users(id), reported_id TEXT NOT NULL REFERENCES mp_users(id),
 booking_id TEXT REFERENCES mp_bookings(id), category TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('STANDARD','URGENT')),
 narrative TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('OPEN','ASSIGNED','ESCALATED','CLOSED')),
 assigned_to TEXT REFERENCES mp_users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 CHECK(reporter_id<>reported_id), UNIQUE(reporter_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_safety_queue ON mp_safety_reports(status,severity,created_at);
CREATE TABLE IF NOT EXISTS mp_case_events (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES mp_safety_reports(id),
 reviewer_id TEXT NOT NULL REFERENCES mp_users(id), decision TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_activity_sessions (
 booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id), activity_id TEXT,
 revision INTEGER NOT NULL DEFAULT 0, prompt_index INTEGER NOT NULL DEFAULT 0,
 answer_revealed INTEGER NOT NULL DEFAULT 0 CHECK(answer_revealed IN (0,1)),
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
 updated_by TEXT REFERENCES mp_users(id), updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_activity_events (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES mp_bookings(id),
 revision INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES mp_users(id),
 action TEXT NOT NULL, activity_id TEXT, created_at INTEGER NOT NULL, UNIQUE(booking_id,revision)
);
CREATE TABLE IF NOT EXISTS mp_payments (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE REFERENCES mp_bookings(id), provider_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('PENDING','FAILED','CAPTURED','REFUNDED','DISPUTED')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), currency TEXT NOT NULL CHECK(currency='USD'),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_webhook_events (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, type TEXT NOT NULL, processing_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_ledger_entries (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES mp_bookings(id), payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 event_id TEXT NOT NULL, account TEXT NOT NULL, debit_cents INTEGER NOT NULL CHECK(debit_cents>=0),
 credit_cents INTEGER NOT NULL CHECK(credit_cents>=0), created_at INTEGER NOT NULL,
 CHECK((debit_cents=0 AND credit_cents>0) OR (credit_cents=0 AND debit_cents>0)),
 UNIQUE(event_id,account)
);
CREATE TRIGGER IF NOT EXISTS mp_ledger_no_update BEFORE UPDATE ON mp_ledger_entries BEGIN SELECT RAISE(ABORT,'Ledger entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_ledger_no_delete BEFORE DELETE ON mp_ledger_entries BEGIN SELECT RAISE(ABORT,'Ledger entries are append-only'); END;
CREATE TABLE IF NOT EXISTS mp_refunds (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE REFERENCES mp_bookings(id), payment_id TEXT NOT NULL REFERENCES mp_payments(id),
 reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('OPEN','APPROVED','REJECTED','REFUNDED')),
 reviewer_id TEXT REFERENCES mp_users(id), resolution TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_reviews (
 booking_id TEXT PRIMARY KEY REFERENCES mp_bookings(id), customer_id TEXT NOT NULL REFERENCES mp_users(id),
 rating INTEGER CHECK(rating BETWEEN 1 AND 5), worth_it INTEGER CHECK(worth_it IN (0,1)),
 private_feedback TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES mp_users(id), booking_id TEXT REFERENCES mp_bookings(id),
 kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DELIVERED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_audit_events (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES mp_users(id), subject_id TEXT NOT NULL, action TEXT NOT NULL,
 details TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_rate_limits (
 user_id TEXT NOT NULL REFERENCES mp_users(id), window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user_id,window)
);

