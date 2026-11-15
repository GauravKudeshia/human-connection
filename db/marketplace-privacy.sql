-- Additive privacy workflow. No existing financial or policy evidence is deleted.
CREATE TABLE IF NOT EXISTS mp_privacy_deletions (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES mp_users(id),
 request_key TEXT NOT NULL,receipt_hash TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('REQUESTED','WAITING','PROCESSING','COMPLETED','FAILED')),
 policy_version TEXT,policy_snapshot TEXT,requested_at INTEGER NOT NULL,
 eligible_at INTEGER,next_attempt_at INTEGER NOT NULL,completed_at INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0,wait_reason TEXT,
 UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS mp_privacy_due ON mp_privacy_deletions(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS mp_privacy_subject_blocks (
 subject_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES mp_users(id),created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_privacy_purge_leases (
 request_id TEXT PRIMARY KEY REFERENCES mp_privacy_deletions(id),owner TEXT NOT NULL,expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mp_privacy_holds (
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES mp_privacy_deletions(id),
 user_id TEXT NOT NULL REFERENCES mp_users(id),scope TEXT NOT NULL CHECK(scope IN ('ALL','FINANCIAL','SAFETY')),
 reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ACTIVE','RELEASED')),
 created_by TEXT NOT NULL REFERENCES mp_users(id),created_at INTEGER NOT NULL,
 released_by TEXT REFERENCES mp_users(id),released_at INTEGER,release_reason TEXT,
 request_key TEXT NOT NULL,UNIQUE(created_by,request_key)
);
CREATE INDEX IF NOT EXISTS mp_privacy_active_holds ON mp_privacy_holds(user_id,status);
CREATE TABLE IF NOT EXISTS mp_privacy_events (
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES mp_privacy_deletions(id),
 actor_id TEXT REFERENCES mp_users(id),action TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mp_privacy_event_no_update BEFORE UPDATE ON mp_privacy_events BEGIN SELECT RAISE(ABORT,'Privacy events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_privacy_event_no_delete BEFORE DELETE ON mp_privacy_events BEGIN SELECT RAISE(ABORT,'Privacy events are append-only'); END;
CREATE TABLE IF NOT EXISTS mp_privacy_retention_runs (
 id TEXT PRIMARY KEY,policy_version TEXT NOT NULL,run_at INTEGER NOT NULL,removed INTEGER NOT NULL CHECK(removed>=0)
);
CREATE TRIGGER IF NOT EXISTS mp_privacy_runs_no_update BEFORE UPDATE ON mp_privacy_retention_runs BEGIN SELECT RAISE(ABORT,'Retention evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS mp_privacy_runs_no_delete BEFORE DELETE ON mp_privacy_retention_runs BEGIN SELECT RAISE(ABORT,'Retention evidence is append-only'); END;
