-- Additive, repeatable staging migration. Keep private evidence out of public profile rows.
CREATE TABLE IF NOT EXISTS mp_policy_acceptances (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES mp_users(id),kind TEXT NOT NULL,
 version TEXT NOT NULL,accepted_at INTEGER NOT NULL,
 UNIQUE(user_id,kind,version)
);
CREATE TABLE IF NOT EXISTS mp_customer_eligibility (
 user_id TEXT PRIMARY KEY REFERENCES mp_users(id),adult INTEGER NOT NULL CHECK(adult=1),
 us INTEGER NOT NULL CHECK(us=1),policy_version TEXT NOT NULL,accepted_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mp_policy_no_update BEFORE UPDATE ON mp_policy_acceptances BEGIN SELECT RAISE(ABORT,'Policy acceptance records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_policy_no_delete BEFORE DELETE ON mp_policy_acceptances BEGIN SELECT RAISE(ABORT,'Policy acceptance records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_host_initial_acceptance AFTER INSERT ON mp_host_profiles BEGIN
 INSERT OR IGNORE INTO mp_policy_acceptances VALUES(lower(hex(randomblob(16))),NEW.user_id,'host-policy',NEW.policy_version,NEW.created_at);
 INSERT OR IGNORE INTO mp_policy_acceptances VALUES(lower(hex(randomblob(16))),NEW.user_id,'host-training',NEW.training_version,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mp_host_updated_acceptance AFTER UPDATE OF policy_version,training_version ON mp_host_profiles BEGIN
 INSERT OR IGNORE INTO mp_policy_acceptances VALUES(lower(hex(randomblob(16))),NEW.user_id,'host-policy',NEW.policy_version,NEW.updated_at);
 INSERT OR IGNORE INTO mp_policy_acceptances VALUES(lower(hex(randomblob(16))),NEW.user_id,'host-training',NEW.training_version,NEW.updated_at);
END;
INSERT OR IGNORE INTO mp_policy_acceptances SELECT lower(hex(randomblob(16))),user_id,'host-policy',policy_version,created_at FROM mp_host_profiles;
INSERT OR IGNORE INTO mp_policy_acceptances SELECT lower(hex(randomblob(16))),user_id,'host-training',training_version,created_at FROM mp_host_profiles;
CREATE TABLE IF NOT EXISTS mp_intro_media (
 id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES mp_users(id),
 object_key TEXT NOT NULL UNIQUE,content_type TEXT NOT NULL,byte_length INTEGER NOT NULL,
 checksum TEXT NOT NULL,transcript TEXT NOT NULL,consent_at INTEGER NOT NULL,
 duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 15 AND 30),
 status TEXT NOT NULL CHECK(status IN ('UPLOADING','PENDING','APPROVED','REJECTED','FAILED')),
 request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,reviewer_id TEXT REFERENCES mp_users(id),
 review_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(host_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_intro_queue ON mp_intro_media(status,created_at);
CREATE TABLE IF NOT EXISTS mp_host_verification_evidence (
 host_id TEXT PRIMARY KEY REFERENCES mp_users(id),identity_reference TEXT NOT NULL,
 payout_reference TEXT NOT NULL,reviewer_id TEXT NOT NULL REFERENCES mp_users(id),
 reviewed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mp_identity_evidence_owner ON mp_host_verification_evidence(identity_reference);
CREATE UNIQUE INDEX IF NOT EXISTS mp_payout_evidence_owner ON mp_host_verification_evidence(payout_reference);
CREATE TABLE IF NOT EXISTS mp_host_appeals (
 id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES mp_users(id),
 reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('OPEN','APPROVED','REJECTED')),
 reviewer_id TEXT REFERENCES mp_users(id),resolution TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 request_key TEXT NOT NULL,UNIQUE(host_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS mp_one_open_appeal ON mp_host_appeals(host_id) WHERE status='OPEN';
CREATE TABLE IF NOT EXISTS mp_analytics_events (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES mp_users(id),
 name TEXT NOT NULL,booking_id TEXT REFERENCES mp_bookings(id),experience TEXT,
 occurred_at INTEGER NOT NULL,request_key TEXT NOT NULL,
 UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_analytics_window ON mp_analytics_events(occurred_at,name);
CREATE TABLE IF NOT EXISTS mp_delivery_leases (
 notification_id TEXT PRIMARY KEY REFERENCES mp_notifications(id),owner TEXT NOT NULL,expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_operator_alerts (
 id TEXT PRIMARY KEY,kind TEXT NOT NULL,subject_id TEXT,created_at INTEGER NOT NULL,
 resolved_at INTEGER,UNIQUE(kind,subject_id)
);

